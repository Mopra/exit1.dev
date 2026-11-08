import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { randomUUID } from "node:crypto";
import { firestore } from "./init";
import { resolveAccount } from "./team-access";
import {
  INCIDENT_LIMITS,
  IncidentValidationError,
  buildPublicIncidents,
  mergeDowntimeIntervals,
  deriveIncidentState,
  parseCheckIds,
  parseLinkedDowntime,
  parseMessage,
  parseStatus,
  parseTimestamp,
  parseTitle,
  sortUpdates,
  type IncidentDoc,
  type IncidentUpdate,
} from "./status-page-incident-policy";

const INCIDENTS = "status_page_incidents";
const STATUS_PAGES = "status_pages";
/** Incidents read back when rebuilding a page's public projection. */
const PROJECTION_SCAN_LIMIT = 60;
const DOWNTIME_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

type Action = "create" | "edit" | "delete" | "addUpdate" | "editUpdate" | "deleteUpdate";
const ACTIONS: readonly Action[] = ["create", "edit", "delete", "addUpdate", "editUpdate", "deleteUpdate"];

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new HttpsError("invalid-argument", `${label} is required`);
  }
  return value;
}

/** The page must belong to the account the caller is acting on. */
async function loadOwnedStatusPage(statusPageId: string, accountId: string): Promise<void> {
  const snap = await firestore.collection(STATUS_PAGES).doc(statusPageId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Status page not found");
  if ((snap.data() as { userId?: string }).userId !== accountId) {
    throw new HttpsError("permission-denied", "You do not have access to this status page");
  }
}

/** Affected checks must belong to the same account (one getAll, owner writes only). */
async function assertChecksOwned(checkIds: string[], accountId: string): Promise<void> {
  if (checkIds.length === 0) return;
  const snaps = await firestore.getAll(...checkIds.map((id) => firestore.collection("checks").doc(id)));
  for (const snap of snaps) {
    if (!snap.exists || (snap.data() as { userId?: string }).userId !== accountId) {
      throw new HttpsError("invalid-argument", "One of the affected checks was not found");
    }
  }
}

/**
 * Rebuild the `incidents` array on the status page doc from the incident docs.
 * Costs one query (up to PROJECTION_SCAN_LIMIT reads) and one write, per owner
 * write. Public viewers read the result through the page doc they already load.
 */
async function rebuildPublicIncidents(statusPageId: string, accountId: string): Promise<void> {
  const snap = await firestore
    .collection(INCIDENTS)
    .where("statusPageId", "==", statusPageId)
    .orderBy("startedAt", "desc")
    .limit(PROJECTION_SCAN_LIMIT)
    .get();
  const incidents = snap.docs
    .map((d) => ({ id: d.id, doc: d.data() as IncidentDoc }))
    .filter(({ doc }) => doc.userId === accountId);
  const now = Date.now();
  await firestore.collection(STATUS_PAGES).doc(statusPageId).update({
    incidents: buildPublicIncidents(incidents, now),
    incidentsUpdatedAt: now,
  });
}

function parseUpdateInput(raw: unknown, now: number): IncidentUpdate {
  const data = (raw ?? {}) as Record<string, unknown>;
  return {
    id: randomUUID(),
    status: parseStatus(data.status),
    message: parseMessage(data.message),
    createdAt: parseTimestamp(data.createdAt, now, "Update time"),
  };
}

function applyUpdates(doc: IncidentDoc, updates: IncidentUpdate[]): IncidentDoc {
  if (updates.length === 0) throw new HttpsError("failed-precondition", "An incident needs at least one update");
  if (updates.length > INCIDENT_LIMITS.updatesMax) {
    throw new HttpsError("failed-precondition", `An incident can have at most ${INCIDENT_LIMITS.updatesMax} updates`);
  }
  const sorted = sortUpdates(updates);
  const { status, resolvedAt } = deriveIncidentState(sorted);
  return { ...doc, updates: sorted, status, resolvedAt };
}

export const manageStatusPageIncident = onCall({ cors: true, maxInstances: 10 }, async (request) => {
  const { accountId, actorUid } = await resolveAccount(request, "write");
  const data = (request.data ?? {}) as Record<string, unknown>;

  const action = data.action as Action;
  if (!ACTIONS.includes(action)) throw new HttpsError("invalid-argument", "Unknown action");
  const statusPageId = asString(data.statusPageId, "statusPageId");
  await loadOwnedStatusPage(statusPageId, accountId);

  const now = Date.now();
  let incidentId: string;

  try {
    if (action === "create") {
      const title = parseTitle(data.title);
      const affectedCheckIds = parseCheckIds(data.affectedCheckIds);
      const linkedDowntime = parseLinkedDowntime(data.linkedDowntime, now);
      const checksToVerify = linkedDowntime && !affectedCheckIds.includes(linkedDowntime.checkId)
        ? [...affectedCheckIds, linkedDowntime.checkId]
        : affectedCheckIds;
      await assertChecksOwned(checksToVerify, accountId);

      const first = parseUpdateInput(data.update, now);
      // Annotating a past outage: the incident starts when the downtime did.
      const startedAt = data.startedAt != null
        ? parseTimestamp(data.startedAt, now, "Start time")
        : Math.min(first.createdAt, linkedDowntime?.startedAt ?? first.createdAt);

      const base: IncidentDoc = {
        userId: accountId,
        statusPageId,
        title,
        status: first.status,
        affectedCheckIds,
        linkedDowntime,
        startedAt,
        resolvedAt: null,
        updates: [],
        createdAt: now,
        updatedAt: now,
        createdBy: actorUid,
        updatedBy: actorUid,
      };
      const ref = firestore.collection(INCIDENTS).doc();
      await ref.set(applyUpdates(base, [first]));
      incidentId = ref.id;
    } else {
      incidentId = asString(data.incidentId, "incidentId");
      const ref = firestore.collection(INCIDENTS).doc(incidentId);

      // Validate everything that needs a read outside the transaction.
      const editFields: Partial<IncidentDoc> = {};
      if (action === "edit") {
        if (data.title !== undefined) editFields.title = parseTitle(data.title);
        if (data.affectedCheckIds !== undefined) editFields.affectedCheckIds = parseCheckIds(data.affectedCheckIds);
        if (data.linkedDowntime !== undefined) editFields.linkedDowntime = parseLinkedDowntime(data.linkedDowntime, now);
        if (data.startedAt !== undefined) editFields.startedAt = parseTimestamp(data.startedAt, now, "Start time");
        const verify = [...(editFields.affectedCheckIds ?? [])];
        if (editFields.linkedDowntime && !verify.includes(editFields.linkedDowntime.checkId)) {
          verify.push(editFields.linkedDowntime.checkId);
        }
        await assertChecksOwned(verify, accountId);
      }

      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError("not-found", "Incident not found");
        const current = snap.data() as IncidentDoc;
        if (current.userId !== accountId || current.statusPageId !== statusPageId) {
          throw new HttpsError("permission-denied", "You do not have access to this incident");
        }

        if (action === "delete") {
          tx.delete(ref);
          return;
        }

        let next: IncidentDoc = { ...current, updatedAt: now, updatedBy: actorUid };
        if (action === "edit") {
          next = { ...next, ...editFields };
        } else if (action === "addUpdate") {
          next = applyUpdates(next, [...current.updates, parseUpdateInput(data.update, now)]);
        } else {
          const updateId = asString(data.updateId, "updateId");
          const existing = current.updates.find((u) => u.id === updateId);
          if (!existing) throw new HttpsError("not-found", "Update not found");
          if (action === "deleteUpdate") {
            next = applyUpdates(next, current.updates.filter((u) => u.id !== updateId));
          } else {
            const patch = (data.update ?? {}) as Record<string, unknown>;
            const edited: IncidentUpdate = {
              id: existing.id,
              status: patch.status !== undefined ? parseStatus(patch.status) : existing.status,
              message: patch.message !== undefined ? parseMessage(patch.message) : existing.message,
              createdAt: patch.createdAt !== undefined ? parseTimestamp(patch.createdAt, now, "Update time") : existing.createdAt,
            };
            next = applyUpdates(next, current.updates.map((u) => (u.id === updateId ? edited : u)));
          }
        }
        // The incident cannot start after its first update.
        const firstUpdateAt = next.updates[0]?.createdAt;
        if (typeof firstUpdateAt === "number" && next.startedAt > firstUpdateAt) next.startedAt = firstUpdateAt;
        tx.set(ref, next);
      });
    }
  } catch (error) {
    if (error instanceof IncidentValidationError) throw new HttpsError("invalid-argument", error.message);
    throw error;
  }

  await rebuildPublicIncidents(statusPageId, accountId);
  return { success: true, incidentId };
});

/**
 * Detected outages for one check over the last 30 days, so the owner can pick
 * one to annotate. Owner-only, on demand from the incident editor.
 */
export const getStatusPageCheckDowntimes = onCall({ cors: true, maxInstances: 5 }, async (request) => {
  const { accountId } = await resolveAccount(request, "read");
  const data = (request.data ?? {}) as Record<string, unknown>;
  const statusPageId = asString(data.statusPageId, "statusPageId");
  const checkId = asString(data.checkId, "checkId");
  await loadOwnedStatusPage(statusPageId, accountId);
  await assertChecksOwned([checkId], accountId);

  const endDate = Date.now();
  const startDate = endDate - DOWNTIME_LOOKBACK_MS;
  try {
    const { getIncidentIntervals } = await import("./bigquery.js");
    const rows = await getIncidentIntervals(checkId, accountId, startDate, endDate);
    return { success: true, data: { downtimes: mergeDowntimeIntervals(rows, endDate), startDate, endDate } };
  } catch (error) {
    logger.error("[getStatusPageCheckDowntimes] BigQuery failed", error);
    throw new HttpsError("internal", "Could not load downtime history");
  }
});
