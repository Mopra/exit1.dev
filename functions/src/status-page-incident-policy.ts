/**
 * Incidents on customer status pages: validation and the public projection.
 * Pure, so the rules are testable without Firestore.
 *
 * Source of truth is `status_page_incidents/{id}` (owner-readable, written only
 * by the manageStatusPageIncident callable). Public viewers never read that
 * collection. Every write rebuilds a small `incidents` array on the status page
 * doc itself, which the public page already subscribes to, so showing incidents
 * adds no per-view Firestore read.
 */

export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_LIMITS = {
  titleMin: 3,
  titleMax: 140,
  messageMax: 2000,
  updatesMax: 50,
  affectedChecksMax: 50,
  /** How far back a timestamp may be set (annotating an old outage). */
  backdateMaxMs: 400 * 24 * 60 * 60 * 1000,
  /** Clock skew allowance for timestamps slightly in the future. */
  futureSkewMs: 5 * 60 * 1000,
} as const;

/** Past incidents stay on the public page for this long after resolving. */
export const PUBLIC_HISTORY_MS = 90 * 24 * 60 * 60 * 1000;
export const PUBLIC_MAX_INCIDENTS = 25;
/** Keeps the status page doc well under Firestore's 1 MiB cap. */
export const PUBLIC_MAX_BYTES = 200 * 1024;

export interface IncidentUpdate {
  id: string;
  status: IncidentStatus;
  message: string;
  createdAt: number;
}

export interface LinkedDowntime {
  checkId: string;
  startedAt: number;
  endedAt: number | null;
}

export interface IncidentDoc {
  userId: string;
  statusPageId: string;
  title: string;
  status: IncidentStatus;
  affectedCheckIds: string[];
  linkedDowntime: LinkedDowntime | null;
  startedAt: number;
  resolvedAt: number | null;
  updates: IncidentUpdate[];
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
}

/** What the public status page sees. No uids, no audit fields. */
export interface PublicStatusPageIncident {
  id: string;
  title: string;
  status: IncidentStatus;
  affectedCheckIds: string[];
  linkedDowntime: LinkedDowntime | null;
  startedAt: number;
  resolvedAt: number | null;
  /** Newest first. */
  updates: IncidentUpdate[];
}

export class IncidentValidationError extends Error {}

const fail = (message: string): never => {
  throw new IncidentValidationError(message);
};

export function isIncidentStatus(value: unknown): value is IncidentStatus {
  return typeof value === "string" && (INCIDENT_STATUSES as readonly string[]).includes(value);
}

export function parseTitle(value: unknown): string {
  if (typeof value !== "string") return fail("Title is required");
  const title = value.replace(/\s+/g, " ").trim();
  if (title.length < INCIDENT_LIMITS.titleMin) return fail(`Title must be at least ${INCIDENT_LIMITS.titleMin} characters`);
  if (title.length > INCIDENT_LIMITS.titleMax) return fail(`Title must be at most ${INCIDENT_LIMITS.titleMax} characters`);
  return title;
}

export function parseMessage(value: unknown): string {
  if (typeof value !== "string") return fail("Message is required");
  const message = value.replace(/\r\n/g, "\n").trim();
  if (!message) return fail("Message is required");
  if (message.length > INCIDENT_LIMITS.messageMax) return fail(`Message must be at most ${INCIDENT_LIMITS.messageMax} characters`);
  return message;
}

export function parseStatus(value: unknown): IncidentStatus {
  if (!isIncidentStatus(value)) return fail("Status must be investigating, identified, monitoring or resolved");
  return value;
}

/** Optional timestamp: missing means `now`. Bounded so typos can't land in 1970 or 2099. */
export function parseTimestamp(value: unknown, now: number, label: string): number {
  if (value === undefined || value === null) return now;
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(`${label} must be a timestamp`);
  const ts = Math.round(value);
  if (ts > now + INCIDENT_LIMITS.futureSkewMs) return fail(`${label} cannot be in the future`);
  if (ts < now - INCIDENT_LIMITS.backdateMaxMs) return fail(`${label} is too far in the past`);
  return ts;
}

export function parseCheckIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail("Affected checks must be a list");
  const ids = Array.from(new Set(
    value.filter((id): id is string => typeof id === "string" && id.trim().length > 0 && id.length <= 128),
  ));
  if (ids.length > INCIDENT_LIMITS.affectedChecksMax) return fail(`At most ${INCIDENT_LIMITS.affectedChecksMax} affected checks`);
  return ids;
}

export function parseLinkedDowntime(value: unknown, now: number): LinkedDowntime | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return fail("Linked downtime is invalid");
  const raw = value as Record<string, unknown>;
  if (typeof raw.checkId !== "string" || !raw.checkId.trim() || raw.checkId.length > 128) return fail("Linked downtime needs a check");
  if (raw.startedAt === undefined || raw.startedAt === null) return fail("Linked downtime needs a start time");
  const startedAt = parseTimestamp(raw.startedAt, now, "Downtime start");
  let endedAt: number | null = null;
  if (raw.endedAt !== undefined && raw.endedAt !== null) {
    endedAt = parseTimestamp(raw.endedAt, now, "Downtime end");
    if (endedAt < startedAt) return fail("Downtime cannot end before it starts");
  }
  return { checkId: raw.checkId, startedAt, endedAt };
}

/** Updates sorted oldest first (storage order). */
export function sortUpdates(updates: IncidentUpdate[]): IncidentUpdate[] {
  return [...updates].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * The incident's status is the status of its latest update, and it is resolved
 * at the time of that update. Re-opening (posting a non-resolved update after a
 * resolved one) clears resolvedAt.
 */
export function deriveIncidentState(updates: IncidentUpdate[]): { status: IncidentStatus; resolvedAt: number | null } {
  const sorted = sortUpdates(updates);
  const latest = sorted[sorted.length - 1];
  if (!latest) return { status: "investigating", resolvedAt: null };
  return { status: latest.status, resolvedAt: latest.status === "resolved" ? latest.createdAt : null };
}

export function toPublicIncident(id: string, doc: IncidentDoc): PublicStatusPageIncident {
  return {
    id,
    title: doc.title,
    status: doc.status,
    affectedCheckIds: doc.affectedCheckIds ?? [],
    linkedDowntime: doc.linkedDowntime ?? null,
    startedAt: doc.startedAt,
    resolvedAt: doc.resolvedAt ?? null,
    updates: sortUpdates(doc.updates ?? []).reverse(),
  };
}

/**
 * Which incidents go on the public page: every open one, plus those resolved in
 * the last 90 days. Open first, then most recent. Capped by count and bytes,
 * dropping the oldest resolved incidents first.
 */
export function buildPublicIncidents(
  incidents: Array<{ id: string; doc: IncidentDoc }>,
  now: number,
): PublicStatusPageIncident[] {
  const cutoff = now - PUBLIC_HISTORY_MS;
  const visible = incidents
    .filter(({ doc }) => doc.resolvedAt == null || doc.resolvedAt >= cutoff)
    .map(({ id, doc }) => toPublicIncident(id, doc));

  const open = visible.filter((i) => i.resolvedAt == null).sort((a, b) => b.startedAt - a.startedAt);
  const resolved = visible.filter((i) => i.resolvedAt != null).sort((a, b) => b.startedAt - a.startedAt);
  const result = [...open, ...resolved].slice(0, PUBLIC_MAX_INCIDENTS);

  while (result.length > 1 && Buffer.byteLength(JSON.stringify(result), "utf8") > PUBLIC_MAX_BYTES) {
    result.pop();
  }
  return result;
}

/** Down intervals closer together than this are shown as one outage in the picker. */
const DOWNTIME_MERGE_GAP_MS = 10 * 60 * 1000;
const DOWNTIME_MAX_RESULTS = 50;

export interface DowntimeWindow {
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
}

/** Merge raw offline intervals that are only a few minutes apart (the downtime picker). */
export function mergeDowntimeIntervals(
  rows: Array<{ started_at_ms: number; ended_at_ms: number }>,
  endDate: number,
): DowntimeWindow[] {
  const sorted = rows
    .map((r) => ({ start: Number(r.started_at_ms), end: Number(r.ended_at_ms) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const row of sorted) {
    const last = merged[merged.length - 1];
    if (last && row.start - last.end <= DOWNTIME_MERGE_GAP_MS) {
      last.end = Math.max(last.end, row.end);
    } else {
      merged.push({ ...row });
    }
  }
  return merged
    .reverse()
    .slice(0, DOWNTIME_MAX_RESULTS)
    .map(({ start, end }) => {
      const ongoing = end >= endDate - 1000;
      return { startedAt: start, endedAt: ongoing ? null : end, durationMs: Math.max(0, end - start) };
    });
}
