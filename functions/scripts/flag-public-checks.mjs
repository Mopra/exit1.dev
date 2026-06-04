#!/usr/bin/env node
/**
 * Flag (or unflag) all of an account's checks as public so they appear on the
 * marketing site's uptime landing pages (exit1.dev/status/<slug>).
 *
 * Public exposure is opt-in per check via the `public` flag — this script just
 * bulk-applies it to the curated connect@exit1.dev account. Run after deploying
 * the public-monitors functions; the hourly cron picks the flagged checks up
 * (or trigger getPublicMonitors once to force a cold build).
 *
 * Usage (from the functions/ directory):
 *   node scripts/flag-public-checks.mjs <uid>            # flag all non-domain checks
 *   node scripts/flag-public-checks.mjs <uid> --dry      # preview, write nothing
 *   node scripts/flag-public-checks.mjs <uid> --unflag   # remove the public flag
 *
 * Auth: uses Application Default Credentials (the same `gcloud auth` /
 * service-account identity you deploy functions with). Set GOOGLE_CLOUD_PROJECT
 * or rely on the default below.
 *
 * Finding the uid: open any check owned by connect@ in the Firestore console
 * and copy its `userId` field, or grab it from the Clerk dashboard.
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || "exit1-dev";

const args = process.argv.slice(2);
const uid = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry");
const unflag = args.includes("--unflag");

if (!uid) {
  console.error("Error: missing <uid>.\nUsage: node scripts/flag-public-checks.mjs <uid> [--dry] [--unflag]");
  process.exit(1);
}

initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
const db = getFirestore();

function hostFromUrl(url) {
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return String(url).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
  }
}

function slugify(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

async function main() {
  const snap = await db.collection("checks").where("userId", "==", uid).get();
  if (snap.empty) {
    console.log(`No checks found for uid ${uid}.`);
    return;
  }

  // Eligible = anything that actually produces uptime data.
  const eligible = snap.docs.filter((d) => {
    const data = d.data();
    return data.type !== "domain";
  });

  console.log(`Found ${snap.size} checks (${eligible.length} eligible) for uid ${uid}.`);

  if (unflag) {
    let n = 0;
    for (let i = 0; i < snap.docs.length; i += 450) {
      const batch = db.batch();
      for (const doc of snap.docs.slice(i, i + 450)) {
        batch.update(doc.ref, { public: false });
        n++;
      }
      if (!dryRun) await batch.commit();
    }
    console.log(`${dryRun ? "[dry] would unflag" : "Unflagged"} ${n} checks.`);
    return;
  }

  // Assign collision-free slugs (skip checks that already have an explicit publicSlug).
  const used = new Set();
  for (const doc of eligible) {
    const existing = doc.data().publicSlug;
    if (existing) used.add(slugify(existing));
  }

  const updates = [];
  for (const doc of eligible) {
    const data = doc.data();
    let slug = data.publicSlug ? slugify(data.publicSlug) : "";
    if (!slug) {
      const base = slugify(hostFromUrl(data.url || "")) || slugify(data.name || "") || doc.id;
      slug = base;
      let k = 2;
      while (used.has(slug)) slug = `${base}-${k++}`;
      used.add(slug);
    }
    updates.push({ ref: doc.ref, slug, name: data.name || data.url });
  }

  for (const u of updates) {
    console.log(`  ${u.slug.padEnd(32)} ← ${u.name}`);
  }

  if (dryRun) {
    console.log(`[dry] would flag ${updates.length} checks public. No writes made.`);
    return;
  }

  for (let i = 0; i < updates.length; i += 450) {
    const batch = db.batch();
    for (const u of updates.slice(i, i + 450)) {
      batch.update(u.ref, { public: true, publicSlug: u.slug });
    }
    await batch.commit();
  }
  console.log(`Flagged ${updates.length} checks public.`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
