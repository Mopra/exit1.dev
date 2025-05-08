/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// import {onRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// export const helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

initializeApp({ credential: applicationDefault() });
const firestore = getFirestore();

// Distributed: Scheduled function to enqueue check tasks
export const enqueueWebsiteChecks = onSchedule("every 1 minutes", async () => {
  const websitesSnapshot = await firestore.collection("websites").get();
  const batch = firestore.batch();
  for (const doc of websitesSnapshot.docs) {
    const websiteId = doc.id;
    const checkTaskRef = firestore.collection("websiteChecks").doc();
    batch.set(checkTaskRef, {
      websiteId,
      url: doc.data().url,
      created: Date.now(),
    });
  }
  await batch.commit();
  logger.info(`Enqueued ${websitesSnapshot.size} website check tasks.`);
});

// Distributed: Worker function to process each check task
export const processWebsiteCheck = onDocumentCreated(
  "websiteChecks/{taskId}",
  async (event) => {
    const data = event.data?.data();
    if (!data) return;
    const { websiteId, url } = data;
    let status = "offline";
    try {
      const res = await fetch(url, { method: "HEAD" });
      status = res.ok ? "online" : "offline";
    } catch {
      status = "offline";
    }
    await firestore.collection("websites").doc(websiteId).update({
      status,
      lastChecked: Date.now(),
    });
    // Delete the task document after processing
    await event.data?.ref.delete();
    logger.info(`Checked website ${websiteId} (${url}): ${status}`);
  }
);

// (Optional) Remove or comment out the old checkWebsitesStatus function if you want to fully switch to distributed
