import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";
import { checkSecurityAndExpiry } from "./security-utils";

// Reliability constants (reused from status-buffer.ts patterns)
const FIRESTORE_BATCH_SIZE = 400;
const MAX_PARALLEL_CHECKS = 20;
const MAX_WEBSITES = 10000;

interface PendingUpdate {
  docId: string;
  updateData: Partial<Website>;
  website: Website;
}

let isShuttingDown = false;
const pendingUpdates: PendingUpdate[] = [];
let writeFailureCount = 0;
let checkFailureCount = 0;
let successfulUpdateCount = 0;
let isFlushing = false;
let currentFlushPromise: Promise<void> | null = null;

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
  isShuttingDown = true;
  logger.info('Received SIGTERM, flushing remaining security updates before shutdown...');
  await flushPendingUpdates();
  process.exit(0);
});

process.on('SIGINT', async () => {
  isShuttingDown = true;
  logger.info('Received SIGINT, flushing remaining security updates before shutdown...');
  await flushPendingUpdates();
  process.exit(0);
});

const isNotFoundError = (error: unknown): boolean => {
  if (!error) return false;
  const code = (error as { code?: number | string })?.code;
  if (code === 5 || code === "5" || code === "not-found") {
    return true;
  }
  const message = (error as Error)?.message ?? "";
  return message.toLowerCase().includes("not found") || message.toLowerCase().includes("missing");
};

const flushPendingUpdates = async (): Promise<void> => {
  // If already flushing, return the existing promise so callers can wait for it
  if (isFlushing) {
    return currentFlushPromise || Promise.resolve();
  }

  if (pendingUpdates.length === 0) return;

  // Acquire lock
  isFlushing = true;

  // Execute flush logic and track the promise
  currentFlushPromise = (async () => {
    const size = pendingUpdates.length;
    logger.info(`Flushing ${size} pending security updates...`);

    // Create snapshot to avoid concurrent modification issues
    const updates = [...pendingUpdates];
    pendingUpdates.length = 0;

    // Process in batches
    for (let i = 0; i < updates.length; i += FIRESTORE_BATCH_SIZE) {
      const batchUpdates = updates.slice(i, i + FIRESTORE_BATCH_SIZE);
      await processBatchUpdates(batchUpdates);
    }
  })().catch(error => {
    logger.error("Error during security updates flush:", error);
  }).finally(() => {
    // Release lock
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
    logger.info(`Batch commit succeeded for ${batchUpdates.length} security updates`);
  } catch (error) {
    logger.warn(
      `Batch commit failed for ${batchUpdates.length} security updates, falling back to per-document writes`,
      {
        error: error instanceof Error ? error.message : String(error),
        code: (error as { code?: number | string })?.code,
      }
    );
    await processUpdatesIndividually(batchUpdates);
  }
};

const processUpdatesIndividually = async (updates: PendingUpdate[]): Promise<void> => {
  for (let i = 0; i < updates.length; i += MAX_PARALLEL_CHECKS) {
    const chunk = updates.slice(i, i + MAX_PARALLEL_CHECKS);
    // Use allSettled to ensure all updates are attempted even if some fail
    await Promise.allSettled(chunk.map(({ docId, updateData, website }) =>
      processSingleUpdate(docId, updateData, website)
    ));
  }
};

const processSingleUpdate = async (
  docId: string,
  updateData: Partial<Website>,
  website: Website
): Promise<void> => {
  const docRef = firestore.collection("checks").doc(docId);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await docRef.update(updateData as any);
    successfulUpdateCount++;
  } catch (error) {
    writeFailureCount++;
    if (isNotFoundError(error)) {
      logger.warn(`Dropping security update for deleted website ${docId}`, {
        websiteId: docId,
        url: website.url,
      });
    } else {
      logger.error(`Failed to update security for ${docId}`, {
        websiteId: docId,
        url: website.url,
        error: error instanceof Error ? error.message : String(error),
        code: (error as { code?: number | string })?.code,
      });
    }
    throw error; // Re-throw to prevent marking as success
  }
};

const processWebsite = async (doc: FirebaseFirestore.QueryDocumentSnapshot): Promise<void> => {
  // Skip processing if shutting down
  if (isShuttingDown) {
    return;
  }

  const website = doc.data() as Website;
  const docId = doc.id;

  try {
    const securityChecks = await checkSecurityAndExpiry(website.url);

    const updateData: Partial<Website> = {};
    let hasUpdates = false;

    if (securityChecks.sslCertificate) {
      updateData.sslCertificate = {
        ...securityChecks.sslCertificate,
        lastChecked: Date.now()
      };
      hasUpdates = true;
    }

    if (securityChecks.domainExpiry) {
      updateData.domainExpiry = {
        ...securityChecks.domainExpiry,
        lastChecked: Date.now()
      };
      hasUpdates = true;
    }

    if (hasUpdates) {
      // Thread-safe: push then check (may exceed batch size slightly, but safe)
      pendingUpdates.push({ docId, updateData, website });
      
      // Flush when batch is full (check after push to avoid race)
      if (pendingUpdates.length >= FIRESTORE_BATCH_SIZE) {
        await flushPendingUpdates();
      }
    }
  } catch (err) {
    checkFailureCount++;
    logger.warn(`Failed to refresh security for ${website.url} (${docId})`, {
      websiteId: docId,
      url: website.url,
      error: err instanceof Error ? err.message : String(err),
      code: (err as { code?: number | string })?.code,
    });
  }
};

export const refreshSecurityMetadata = onSchedule({
  schedule: "every 168 hours",
  timeoutSeconds: 540, // 9 minutes
  memory: "512MiB",
}, async () => {
  logger.info("Starting security metadata refresh...");
  
  // Reset state for this run (critical: clear any stale data from previous runs)
  writeFailureCount = 0;
  checkFailureCount = 0;
  successfulUpdateCount = 0;
  isShuttingDown = false;
  pendingUpdates.length = 0;
  
  // Wait for any ongoing flush to complete before starting
  if (isFlushing && currentFlushPromise) {
    await currentFlushPromise;
  }
  
  try {
    // Memory guard: limit query size
    const snapshot = await firestore.collection("checks")
      .where("disabled", "!=", true)
      .limit(MAX_WEBSITES)
      .get();
      
    if (snapshot.size >= MAX_WEBSITES) {
      logger.warn(`Security refresh hit MAX_WEBSITES limit (${MAX_WEBSITES}), some checks may be skipped`);
    }

    logger.info(`Found ${snapshot.size} active checks to refresh.`);

    // Process with bounded concurrency
    const docs = snapshot.docs;
    for (let i = 0; i < docs.length; i += MAX_PARALLEL_CHECKS) {
      const chunk = docs.slice(i, i + MAX_PARALLEL_CHECKS);
      await Promise.all(chunk.map(processWebsite));
    }

    // Flush remaining updates
    await flushPendingUpdates();

    logger.info(`Security metadata refresh completed. Checks processed: ${snapshot.size}, Successful updates: ${successfulUpdateCount}, Check failures: ${checkFailureCount}, Write failures: ${writeFailureCount}`);

  } catch (error) {
    logger.error("Fatal error in refreshSecurityMetadata:", {
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: number | string })?.code,
      stack: error instanceof Error ? error.stack : undefined,
    });
    
    // Attempt to flush any pending updates before failing
    await flushPendingUpdates();
  }
});









