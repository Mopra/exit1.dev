import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function main() {
    console.log("Initializing Firebase Admin...");
    initializeApp({
        credential: applicationDefault(),
        projectId: "exit1-dev" // Explicitly set project ID if needed, or rely on default
    });

    const db = getFirestore();
    const checksCollection = db.collection("checks");

    console.log("Querying for disabled checks...");
    const snapshot = await checksCollection.where("disabled", "==", true).get();

    if (snapshot.empty) {
        console.log("No disabled checks found.");
        return;
    }

    console.log(`Found ${snapshot.size} disabled checks.`);

    const batchSize = 500;
    let batch = db.batch();
    let count = 0;
    let totalUpdated = 0;

    for (const doc of snapshot.docs) {
        const checkData = doc.data();
        console.log(`Updating check ${doc.id} (${checkData.url})...`);

        batch.update(doc.ref, {
            disabled: false,
            checkFrequency: 1440, // 24 hours in minutes
            nextCheckAt: Date.now(), // Schedule for immediate check
            updatedAt: Date.now(),
            disabledReason: null // Clear the disabled reason
        });

        count++;

        if (count >= batchSize) {
            await batch.commit();
            totalUpdated += count;
            console.log(`Committed batch of ${count} updates.`);
            batch = db.batch();
            count = 0;
        }
    }

    if (count > 0) {
        await batch.commit();
        totalUpdated += count;
        console.log(`Committed final batch of ${count} updates.`);
    }

    console.log(`Successfully re-enabled ${totalUpdated} checks.`);
}

main().catch(console.error);
