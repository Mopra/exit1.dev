import * as logger from "firebase-functions/logger";
import { firestore } from "./init";

// Status update buffer for batching updates
export const statusUpdateBuffer = new Map<string, {
  status?: string;
  lastChecked: number;
  responseTime?: number | null;
  statusCode?: number;
  lastError?: string | null;
  downtimeCount?: number;
  lastDowntime?: number;
  lastFailureTime?: number;
  consecutiveFailures?: number;
  detailedStatus?: string;
  nextCheckAt?: number;
  sslCertificate?: {
    valid: boolean;
    issuer?: string;
    subject?: string;
    validFrom?: number;
    validTo?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  domainExpiry?: {
    valid: boolean;
    registrar?: string;
    domainName?: string;
    expiryDate?: number;
    daysUntilExpiry?: number;
    error?: string;
  };
  disabled?: boolean;
  disabledAt?: number;
  disabledReason?: string;
  updatedAt: number;
}>();

// Flush status updates every 30 seconds
export let statusFlushInterval: NodeJS.Timeout | null = null;

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, flushing status updates before shutdown...');
  if (statusFlushInterval) {
    clearInterval(statusFlushInterval);
    statusFlushInterval = null;
  }
  await flushStatusUpdates();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, flushing status updates before shutdown...');
  if (statusFlushInterval) {
    clearInterval(statusFlushInterval);
    statusFlushInterval = null;
  }
  await flushStatusUpdates();
  process.exit(0);
});

export const initializeStatusFlush = () => {
  if (statusFlushInterval) {
    clearInterval(statusFlushInterval);
  }
  
  statusFlushInterval = setInterval(async () => {
    try {
      await flushStatusUpdates();
      
      // Memory management: Log buffer size for monitoring
      if (statusUpdateBuffer.size > 1000) {
        logger.warn(`Status update buffer is large: ${statusUpdateBuffer.size} entries`);
      }
    } catch (error) {
      logger.error('Error flushing status updates:', error);
    }
  }, 30 * 1000); // Flush every 30 seconds
};

export const flushStatusUpdates = async () => {
  if (statusUpdateBuffer.size === 0) return;
  
  logger.info(`Flushing status update buffer with ${statusUpdateBuffer.size} entries`);
  
  try {
    // Split large batches to avoid Firestore limits (500 operations per batch)
    const batchSize = 400; // Conservative limit
    const entries = Array.from(statusUpdateBuffer.entries());
    
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = firestore.batch();
      const batchEntries = entries.slice(i, i + batchSize);
      
      for (const [checkId, data] of batchEntries) {
        const docRef = firestore.collection("checks").doc(checkId);
        batch.update(docRef, data);
      }
      
      await batch.commit();
      logger.info(`Committed batch ${Math.floor(i / batchSize) + 1} with ${batchEntries.length} updates`);
    }
    
    logger.info(`Successfully updated ${statusUpdateBuffer.size} checks in total`);
  } catch (error) {
    logger.error('Error committing status update batch:', error);
    // Don't clear the buffer on error - let it retry on next flush
    return;
  }
  
  statusUpdateBuffer.clear();
};

