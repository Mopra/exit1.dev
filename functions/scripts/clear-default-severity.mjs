#!/usr/bin/env node
/**
 * One-off migration for the "use default priority" severity rework.
 *
 * Historically the check form always persisted a severity (defaulting to 3),
 * and the Pushover mapper treated 3 as "unset" — so every stored severity=3 is
 * indistinguishable from "never made a choice" and behaves identically to a
 * missing field. The rework makes an explicit P3 a hard Normal cap, so before
 * (or right after) deploying it, stored severity=3 must be cleared back to
 * unset. This is semantics-preserving under the OLD mapper and restores the
 * intended "default priority" behavior under the NEW one.
 *
 * Usage (from the functions/ directory):
 *   node scripts/clear-default-severity.mjs --dry   # preview, write nothing
 *   node scripts/clear-default-severity.mjs         # delete severity=3 fields
 *
 * Auth: Application Default Credentials, same as flag-public-checks.mjs.
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "exit1-dev";
const dryRun = process.argv.includes("--dry");

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

async function main() {
  const snap = await db.collection("checks").where("severity", "==", 3).get();
  console.log(`Found ${snap.size} checks with severity=3.`);
  if (snap.empty) return;

  const byUser = new Map();
  for (const doc of snap.docs) {
    const uid = doc.data().userId || "(no userId)";
    byUser.set(uid, (byUser.get(uid) || 0) + 1);
  }
  for (const [uid, n] of byUser) console.log(`  ${uid}: ${n} checks`);

  if (dryRun) {
    console.log(`[dry] would clear severity on ${snap.size} checks. No writes made.`);
    return;
  }

  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 450) {
    const batch = db.batch();
    for (const doc of snap.docs.slice(i, i + 450)) {
      batch.update(doc.ref, { severity: FieldValue.delete() });
      n++;
    }
    await batch.commit();
  }
  console.log(`Cleared severity on ${n} checks.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
