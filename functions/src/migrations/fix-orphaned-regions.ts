/**
 * One-off migration: Fix checks orphaned on deleted regions (us-east4, europe-north1)
 *
 * After removing the us-east4 and europe-north1 scheduler functions,
 * any checks assigned to those regions will never be picked up.
 * This script reassigns them to the nearest valid region.
 *
 * Usage:
 *   npx ts-node src/migrations/fix-orphaned-regions.ts [--dry-run]
 *   npx ts-node src/migrations/fix-orphaned-regions.ts --execute
 */

import * as admin from 'firebase-admin';

if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

// The 3 valid regions (must match check-region.ts)
type ValidRegion = "us-central1" | "europe-west1" | "asia-southeast1";
const VALID_REGIONS: ValidRegion[] = ["us-central1", "europe-west1", "asia-southeast1"];

const REGION_CENTERS: { region: ValidRegion; lat: number; lon: number }[] = [
  { region: "us-central1", lat: 41.8781, lon: -93.0977 },
  { region: "europe-west1", lat: 50.4561, lon: 3.8247 },
  { region: "asia-southeast1", lat: 1.3521, lon: 103.8198 },
];

const toRad = (deg: number) => (deg * Math.PI) / 180;
const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

function pickNearestRegion(lat: number | undefined, lon: number | undefined): ValidRegion {
  if (typeof lat !== "number" || typeof lon !== "number") return "us-central1";
  let best: { region: ValidRegion; dist: number } | null = null;
  for (const c of REGION_CENTERS) {
    const dist = haversineKm(lat, lon, c.lat, c.lon);
    if (!best || dist < best.dist) best = { region: c.region, dist };
  }
  return best?.region ?? "us-central1";
}

// Regions that no longer have schedulers
const ORPHANED_REGIONS = ["us-east4", "us-west1", "europe-north1", "europe-west2", "europe-west3"];

async function fixOrphanedRegions(dryRun: boolean) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Fix Orphaned Regions ${dryRun ? '(DRY RUN)' : '(EXECUTING)'}`);
  console.log(`${'='.repeat(60)}\n`);

  let totalFound = 0;
  let totalFixed = 0;
  let totalOverrideFixed = 0;

  for (const orphanedRegion of ORPHANED_REGIONS) {
    console.log(`\nQuerying for checks with checkRegion = "${orphanedRegion}"...`);
    const snapshot = await firestore
      .collection("checks")
      .where("checkRegion", "==", orphanedRegion)
      .get();

    if (snapshot.empty) {
      console.log(`  No checks found in ${orphanedRegion}`);
      continue;
    }

    console.log(`  Found ${snapshot.size} checks in ${orphanedRegion}`);
    totalFound += snapshot.size;

    let batch = firestore.batch();
    let batchCount = 0;

    for (const doc of snapshot.docs) {
      const check = doc.data();
      const targetLat = check.targetLatitude;
      const targetLon = check.targetLongitude;
      const newRegion = pickNearestRegion(targetLat, targetLon);

      console.log(`  ${check.url || doc.id}: ${orphanedRegion} -> ${newRegion} (lat=${targetLat}, lon=${targetLon})`);

      if (!dryRun) {
        const updateData: { [key: string]: string | number | null } = {
          checkRegion: newRegion,
          updatedAt: Date.now(),
        };

        // Also clear checkRegionOverride if it points to an invalid region
        if (check.checkRegionOverride && !VALID_REGIONS.includes(check.checkRegionOverride)) {
          updateData.checkRegionOverride = null;
          totalOverrideFixed++;
          console.log(`    Also clearing invalid checkRegionOverride: ${check.checkRegionOverride}`);
        }

        batch.update(doc.ref, updateData);
        batchCount++;
        totalFixed++;

        if (batchCount >= 450) {
          await batch.commit();
          batch = firestore.batch();
          batchCount = 0;
        }
      }
    }

    if (!dryRun && batchCount > 0) {
      await batch.commit();
    }
  }

  // Also check for checkRegionOverride pointing to invalid regions
  console.log(`\nChecking for invalid checkRegionOverride values...`);
  for (const orphanedRegion of ORPHANED_REGIONS) {
    const overrideSnapshot = await firestore
      .collection("checks")
      .where("checkRegionOverride", "==", orphanedRegion)
      .get();

    if (!overrideSnapshot.empty) {
      console.log(`  Found ${overrideSnapshot.size} checks with checkRegionOverride = "${orphanedRegion}"`);
      if (!dryRun) {
        const batch = firestore.batch();
        for (const doc of overrideSnapshot.docs) {
          batch.update(doc.ref, { checkRegionOverride: null, updatedAt: Date.now() });
          totalOverrideFixed++;
        }
        await batch.commit();
      }
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Checks on orphaned regions: ${totalFound}`);
  console.log(`Checks reassigned:          ${dryRun ? '0 (dry run)' : totalFixed}`);
  console.log(`Overrides cleared:          ${dryRun ? 'N/A (dry run)' : totalOverrideFixed}`);
  if (dryRun) {
    console.log(`\nThis was a DRY RUN. Run with --execute to apply changes.`);
  }
}

const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');

fixOrphanedRegions(dryRun)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
