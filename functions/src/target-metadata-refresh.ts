import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";
import { buildTargetMetadataBestEffort, TargetMetadata } from "./target-metadata";
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

const needsRefresh = (website: Website, now: number): boolean => {
  const lastChecked = website.targetMetadataLastChecked;
  if (typeof lastChecked !== "number") return true;
  const hasGeo =
    typeof website.targetLatitude === "number" &&
    typeof website.targetLongitude === "number";
  const ttl = hasGeo ? CONFIG.TARGET_METADATA_TTL_MS : CONFIG.TARGET_METADATA_RETRY_MS;
  return now - lastChecked >= ttl;
};

const buildUpdateData = (meta: TargetMetadata, now: number): Partial<Website> => {
  const update: Partial<Website> = { targetMetadataLastChecked: now };
  if (meta.hostname) update.targetHostname = meta.hostname;
  if (meta.ip) update.targetIp = meta.ip;
  if (meta.ipsJson) update.targetIpsJson = meta.ipsJson;
  if (meta.ipFamily) update.targetIpFamily = meta.ipFamily;
  if (meta.geo?.country) update.targetCountry = meta.geo.country;
  if (meta.geo?.region) update.targetRegion = meta.geo.region;
  if (meta.geo?.city) update.targetCity = meta.geo.city;
  if (typeof meta.geo?.latitude === "number") update.targetLatitude = meta.geo.latitude;
  if (typeof meta.geo?.longitude === "number") update.targetLongitude = meta.geo.longitude;
  if (meta.geo?.asn) update.targetAsn = meta.geo.asn;
  if (meta.geo?.org) update.targetOrg = meta.geo.org;
  if (meta.geo?.isp) update.targetIsp = meta.geo.isp;
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
    const meta = await buildTargetMetadataBestEffort(website.url);
    const updateData = buildUpdateData(meta, now);

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
    schedule: "every 2 hours",
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
