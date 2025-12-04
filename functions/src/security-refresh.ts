import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { firestore } from "./init";
import { Website } from "./types";
import { checkSecurityAndExpiry } from "./security-utils";

export const refreshSecurityMetadata = onSchedule({
  schedule: "every 24 hours",
  timeoutSeconds: 540, // 9 minutes
  memory: "512MiB",
}, async () => {
  logger.info("Starting security metadata refresh...");
  
  try {
    // Only check active websites
    // Note: Firestore doesn't support multiple inequality filters, so we just filter by disabled != true
    // If we had other filters like 'deleted', we'd need to handle them carefully.
    const snapshot = await firestore.collection("websites")
      .where("disabled", "!=", true)
      .get();
      
    logger.info(`Found ${snapshot.size} active websites to check.`);

    // Process in chunks to avoid hitting rate limits or memory issues
    const chunkSize = 10;
    const chunks = [];
    for (let i = 0; i < snapshot.docs.length; i += chunkSize) {
      chunks.push(snapshot.docs.slice(i, i + chunkSize));
    }

    let processedCount = 0;
    let errorCount = 0;

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (doc) => {
        const website = doc.data() as Website;
        
        // Skip checks for non-http(s) or local addresses if needed, 
        // but checkSecurityAndExpiry handles validation.
        
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
            await doc.ref.update(updateData);
            processedCount++;
          }
        } catch (err) {
          logger.warn(`Failed to refresh security for ${website.url} (${doc.id}):`, err);
          errorCount++;
        }
      }));
    }

    logger.info(`Security metadata refresh completed. Updated: ${processedCount}, Errors: ${errorCount}`);

  } catch (error) {
    logger.error("Fatal error in refreshSecurityMetadata:", error);
  }
});








