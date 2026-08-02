import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";
import { buildTargetMetadataBestEffort, resolveTarget, TargetMetadata } from "./target-metadata";
import { CONFIG } from "./config";

const FIRESTORE_BATCH_SIZE = 400;
const MAX_PARALLEL_LOOKUPS = 20;
const MAX_WEBSITES = 10000;

interface PendingUpdate {
  docId: string;
  updateData: Partial<Website>;
}

let isShuttingDown = false;
const pendingUpdates: PendingUpdate[] = [];
let writeFailureCount = 0;
let lookupFailureCount = 0;
let successfulUpdateCount = 0;
let skippedCount = 0;
let isFlushing = false;
let currentFlushPromise: Promise<void> | null = null;

// Graceful shutdown handlers — Cloud Functions only (K_SERVICE is set on
// Cloud Run / Gen2). On the VPS the runner owns the process lifecycle; an
// import-time process.exit(0) here would preempt its graceful drain.
if (process.env.K_SERVICE) {
  process.on("SIGTERM", async () => {
    isShuttingDown = true;
    await flushPendingUpdates();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    isShuttingDown = true;
    await flushPendingUpdates();
    process.exit(0);
  });
}

const isNotFoundError = (error: unknown): boolean => {
  if (!error) return false;
  const code = (error as { code?: number | string })?.code;
  if (code === 5 || code === "5" || code === "not-found") return true;
  const message = (error as Error)?.message ?? "";
  return message.toLowerCase().includes("not found") || message.toLowerCase().includes("missing");
};

const flushPendingUpdates = async (): Promise<void> => {
  if (isFlushing) return currentFlushPromise || Promise.resolve();
  if (pendingUpdates.length === 0) return;

  isFlushing = true;
  currentFlushPromise = (async () => {
    const updates = [...pendingUpdates];
    pendingUpdates.length = 0;

    for (let i = 0; i < updates.length; i += FIRESTORE_BATCH_SIZE) {
      const batch = updates.slice(i, i + FIRESTORE_BATCH_SIZE);
      await processBatchUpdates(batch);
    }
  })()
    .catch((error) => {
      logger.error("Error during target metadata flush:", error);
    })
    .finally(() => {
      isFlushing = false;
      currentFlushPromise = null;
    });

  return currentFlushPromise;
};

const processBatchUpdates = async (batchUpdates: PendingUpdate[]): Promise<void> => {
  if (batchUpdates.length === 0) return;

  const batch = firestore.batch();
  for (const { docId, updateData } of batchUpdates) {
    const docRef = firestore.collection("checks").doc(docId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    batch.update(docRef, updateData as any);
  }

  try {
    await batch.commit();
    successfulUpdateCount += batchUpdates.length;
  } catch (error) {
    logger.warn(
      `Batch commit failed for ${batchUpdates.length} target metadata updates, falling back to per-document writes`,
      { error: error instanceof Error ? error.message : String(error) }
    );
    await processUpdatesIndividually(batchUpdates);
  }
};

const processUpdatesIndividually = async (updates: PendingUpdate[]): Promise<void> => {
  for (let i = 0; i < updates.length; i += MAX_PARALLEL_LOOKUPS) {
    const chunk = updates.slice(i, i + MAX_PARALLEL_LOOKUPS);
    await Promise.allSettled(
      chunk.map(async ({ docId, updateData }) => {
        const docRef = firestore.collection("checks").doc(docId);
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await docRef.update(updateData as any);
          successfulUpdateCount++;
        } catch (error) {
          writeFailureCount++;
          if (!isNotFoundError(error)) {
            logger.error(`Failed to update target metadata for ${docId}`, {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })
    );
  }
};

const needsGeoRefresh = (website: Website, now: number): boolean => {
  // targetMetadataLastChecked is only written after a successful geo
  // enrichment; targetMetadataLastAttempt is written when an attempt fails to
  // resolve geo. A check is due when its last success is missing/expired AND
  // it isn't inside the failure backoff window — otherwise every check with a
  // dead geo lookup gets retried on every single daily run.
  const lastChecked = website.targetMetadataLastChecked;
  const succeededRecently =
    typeof lastChecked === "number" && now - lastChecked < CONFIG.TARGET_METADATA_TTL_MS;
  if (succeededRecently) return false;

  const lastAttempt = website.targetMetadataLastAttempt;
  const failedRecently =
    typeof lastAttempt === "number" && now - lastAttempt < CONFIG.TARGET_METADATA_FAILURE_BACKOFF_MS;
  return !failedRecently;
};

// DNS is checked on its own short TTL. It must NOT be gated on the geo backoff:
// that coupling is what let a propagated A-record change stay invisible in the
// UI and in alert emails for weeks while geo enrichment was failing.
const needsDnsRefresh = (website: Website, now: number): boolean => {
  const lastDns = website.targetDnsLastChecked;
  return !(typeof lastDns === "number" && now - lastDns < CONFIG.TARGET_DNS_TTL_MS);
};

const needsRefresh = (website: Website, now: number): boolean =>
  needsDnsRefresh(website, now) || needsGeoRefresh(website, now);

// DNS-only variant of buildTargetMetadataBestEffort — skips the GeoIP call so a
// daily DNS sweep doesn't drag thousands of known-dead geo lookups along.
const buildTargetDnsOnly = async (inputUrl: string): Promise<TargetMetadata> => {
  try {
    const hostname = new URL(inputUrl).hostname;
    const resolved = await resolveTarget(hostname);
    return { hostname, ip: resolved.ip, ipsJson: resolved.ipsJson, ipFamily: resolved.ipFamily };
  } catch {
    return {};
  }
};

const buildUpdateData = (meta: TargetMetadata, now: number): Partial<Website> => {
  const update: Partial<Website> = {};
  if (meta.hostname) update.targetHostname = meta.hostname;
  if (meta.ip) update.targetIp = meta.ip;
  if (meta.ipsJson) update.targetIpsJson = meta.ipsJson;
  if (meta.ipFamily) update.targetIpFamily = meta.ipFamily;
  if (meta.ip) update.targetDnsLastChecked = now;
  if (meta.geo?.country) update.targetCountry = meta.geo.country;
  if (meta.geo?.region) update.targetRegion = meta.geo.region;
  if (meta.geo?.city) update.targetCity = meta.geo.city;
  if (typeof meta.geo?.latitude === "number") update.targetLatitude = meta.geo.latitude;
  if (typeof meta.geo?.longitude === "number") update.targetLongitude = meta.geo.longitude;
  if (meta.geo?.asn) update.targetAsn = meta.geo.asn;
  if (meta.geo?.org) update.targetOrg = meta.geo.org;
  if (meta.geo?.isp) update.targetIsp = meta.geo.isp;
  // Only mark the check as fully refreshed when geo actually came back. If geo
  // failed, leave the timestamp untouched so the next scheduled run retries.
  const hasGeo =
    typeof meta.geo?.latitude === "number" && typeof meta.geo?.longitude === "number";
  if (hasGeo) update.targetMetadataLastChecked = now;
  return update;
};

const processWebsite = async (
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  now: number
): Promise<void> => {
  if (isShuttingDown) return;

  const website = doc.data() as Website;
  const docId = doc.id;

  try {
    // Only pay for the geo lookup when geo is actually due. A check that just
    // needs its DNS re-checked takes the cheap path.
    const withGeo = needsGeoRefresh(website, now);
    const meta = withGeo
      ? await buildTargetMetadataBestEffort(website.url)
      : await buildTargetDnsOnly(website.url);
    const updateData = buildUpdateData(meta, now);

    // Geo didn't resolve — stamp the attempt so the next runs back off
    // (TARGET_METADATA_FAILURE_BACKOFF_MS) instead of retrying daily. Only
    // meaningful when geo was actually attempted; a DNS-only pass must not
    // stamp it, or it would extend the backoff without having tried.
    if (withGeo && typeof updateData.targetMetadataLastChecked !== "number") {
      updateData.targetMetadataLastAttempt = now;
    }

    // A DNS-only pass whose resolve failed produces no fields at all; an empty
    // batch.update() is rejected by Firestore, so drop it.
    if (Object.keys(updateData).length === 0) {
      lookupFailureCount++;
      return;
    }

    pendingUpdates.push({ docId, updateData });

    if (pendingUpdates.length >= FIRESTORE_BATCH_SIZE) {
      await flushPendingUpdates();
    }
  } catch (err) {
    lookupFailureCount++;
    logger.warn(`Target metadata refresh failed for ${website.url} (${docId})`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const refreshTargetMetadata = onSchedule(
  {
    schedule: "every 24 hours",
    timeoutSeconds: 540,
    memory: "256MiB",
  },
  async () => {
    const now = Date.now();

    // Reset state for this run
    writeFailureCount = 0;
    lookupFailureCount = 0;
    successfulUpdateCount = 0;
    skippedCount = 0;
    isShuttingDown = false;
    pendingUpdates.length = 0;

    if (isFlushing && currentFlushPromise) {
      await currentFlushPromise;
    }

    try {
      const snapshot = await firestore
        .collection("checks")
        .where("disabled", "!=", true)
        .limit(MAX_WEBSITES)
        .get();

      if (snapshot.size >= MAX_WEBSITES) {
        logger.warn(`Target metadata refresh hit MAX_WEBSITES limit (${MAX_WEBSITES})`);
      }

      // Filter to checks that need a metadata refresh
      const staleDocs = snapshot.docs.filter((doc) => {
        const website = doc.data() as Website;
        return needsRefresh(website, now);
      });
      skippedCount = snapshot.size - staleDocs.length;

      if (staleDocs.length === 0) {
        logger.info(`Target metadata refresh: 0/${snapshot.size} checks need refresh, skipping.`);
        return;
      }

      // Process with bounded concurrency
      for (let i = 0; i < staleDocs.length; i += MAX_PARALLEL_LOOKUPS) {
        const chunk = staleDocs.slice(i, i + MAX_PARALLEL_LOOKUPS);
        await Promise.all(chunk.map((doc) => processWebsite(doc, now)));
      }

      await flushPendingUpdates();

      logger.info(
        `Target metadata refresh completed. Stale: ${staleDocs.length}, Updated: ${successfulUpdateCount}, Skipped: ${skippedCount}, Lookup failures: ${lookupFailureCount}, Write failures: ${writeFailureCount}`
      );
    } catch (error) {
      logger.error("Fatal error in refreshTargetMetadata:", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      await flushPendingUpdates();
    }
  }
);

export const refreshCheckMetadata = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required");
  }

  const checkId = typeof request.data?.checkId === "string" ? request.data.checkId : "";
  if (!checkId) {
    throw new HttpsError("invalid-argument", "checkId is required");
  }

  const docRef = firestore.collection("checks").doc(checkId);
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Check not found");
  }

  const website = snapshot.data() as Website;
  if (website.userId !== uid) {
    throw new HttpsError("permission-denied", "Insufficient permissions");
  }

  const meta = await buildTargetMetadataBestEffort(website.url);
  const now = Date.now();
  const updateData = buildUpdateData(meta, now);

  if (Object.keys(updateData).length === 0) {
    return { success: false, hasGeo: false, message: "No metadata could be resolved" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await docRef.update(updateData as any);

  const hasGeo =
    typeof meta.geo?.latitude === "number" && typeof meta.geo?.longitude === "number";
  return {
    success: true,
    hasGeo,
    country: meta.geo?.country,
    city: meta.geo?.city,
    ip: meta.ip,
  };
});
