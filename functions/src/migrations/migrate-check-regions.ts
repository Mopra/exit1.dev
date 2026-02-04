/**
 * Migration Script: Reassign all checks to their nearest region
 *
 * After deploying new check regions, existing checks may be assigned to
 * a region that is no longer the nearest. This script recomputes the
 * nearest region for all checks based on their target geo data and
 * updates checkRegion accordingly.
 *
 * Checks with a manual checkRegionOverride are skipped.
 *
 * Usage:
 *   npx ts-node src/migrations/migrate-check-regions.ts [--dry-run]
 *
 * Options:
 *   --dry-run    Preview changes without making updates (default: true)
 *   --execute    Actually perform the migration
 */

import * as admin from 'firebase-admin';

// Initialize Firebase Admin (uses GOOGLE_APPLICATION_CREDENTIALS or default credentials)
if (!admin.apps.length) {
  admin.initializeApp();
}

const firestore = admin.firestore();

// --- Inline region logic (mirrors functions/src/check-region.ts) ---
type CheckRegion =
  | "us-central1"
  | "us-east4"
  | "us-west1"
  | "europe-west1"
  | "europe-west2"
  | "europe-west3"
  | "europe-north1"
  | "asia-southeast1";

const REGION_CENTERS: { region: CheckRegion; lat: number; lon: number }[] = [
  { region: "us-central1", lat: 41.8781, lon: -93.0977 },
  { region: "us-east4", lat: 38.13, lon: -78.45 },
  { region: "us-west1", lat: 45.59, lon: -122.60 },
  { region: "europe-west1", lat: 50.4561, lon: 3.8247 },
  { region: "europe-west2", lat: 51.5074, lon: -0.1278 },
  { region: "europe-west3", lat: 50.1109, lon: 8.6821 },
  { region: "europe-north1", lat: 60.5693, lon: 27.1878 },
  { region: "asia-southeast1", lat: 1.3521, lon: 103.8198 },
];

const toRad = (deg: number) => (deg * Math.PI) / 180;

const haversineKm = (aLat: number, aLon: number, bLat: number, bLon: number): number => {
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

function pickNearestRegion(lat: number | undefined, lon: number | undefined): CheckRegion {
  if (typeof lat !== "number" || typeof lon !== "number") return "us-central1";
  let best: { region: CheckRegion; dist: number } | null = null;
  for (const c of REGION_CENTERS) {
    const dist = haversineKm(lat, lon, c.lat, c.lon);
    if (!best || dist < best.dist) best = { region: c.region, dist };
  }
  return best?.region ?? "us-central1";
}
// --- End inline region logic ---

interface MigrationResult {
  totalChecksScanned: number;
  checksNeedingUpdate: number;
  checksUpdated: number;
  skippedOverride: number;
  skippedNoGeo: number;
  skippedCorrect: number;
  errors: string[];
  regionSummary: Record<string, number>;
}

async function migrateCheckRegions(dryRun: boolean): Promise<MigrationResult> {
  const result: MigrationResult = {
    totalChecksScanned: 0,
    checksNeedingUpdate: 0,
    checksUpdated: 0,
    skippedOverride: 0,
    skippedNoGeo: 0,
    skippedCorrect: 0,
    errors: [],
    regionSummary: {},
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Check Region Migration ${dryRun ? '(DRY RUN)' : '(EXECUTING)'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Query ALL checks across all users
  const checksSnapshot = await firestore.collection('checks').get();
  result.totalChecksScanned = checksSnapshot.size;
  console.log(`Found ${checksSnapshot.size} total checks\n`);

  let batch = firestore.batch();
  let batchCount = 0;
  const now = Date.now();

  for (const doc of checksSnapshot.docs) {
    const check = doc.data();
    const currentRegion: CheckRegion = (check.checkRegion as CheckRegion | undefined) ?? "us-central1";

    // Skip checks with manual override
    if (check.checkRegionOverride) {
      result.skippedOverride++;
      continue;
    }

    const targetLat = check.targetLatitude;
    const targetLon = check.targetLongitude;

    // Skip checks without geo data
    if (typeof targetLat !== "number" || typeof targetLon !== "number") {
      result.skippedNoGeo++;
      continue;
    }

    const desiredRegion = pickNearestRegion(targetLat, targetLon);

    // Track region distribution
    result.regionSummary[desiredRegion] = (result.regionSummary[desiredRegion] || 0) + 1;

    if (currentRegion !== desiredRegion) {
      result.checksNeedingUpdate++;
      console.log(`  ${check.url || doc.id}: ${currentRegion} -> ${desiredRegion}`);

      if (!dryRun) {
        batch.update(doc.ref, {
          checkRegion: desiredRegion,
          nextCheckAt: now, // Reset so new scheduler picks it up immediately
          updatedAt: now,
        });
        batchCount++;
        result.checksUpdated++;

        if (batchCount >= 450) {
          await batch.commit();
          batch = firestore.batch();
          batchCount = 0;
        }
      }
    } else {
      result.skippedCorrect++;
    }
  }

  // Commit remaining
  if (!dryRun && batchCount > 0) {
    await batch.commit();
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Total checks scanned:    ${result.totalChecksScanned}`);
  console.log(`Needing region update:   ${result.checksNeedingUpdate}`);
  console.log(`Actually updated:        ${result.checksUpdated}`);
  console.log(`Skipped (manual override): ${result.skippedOverride}`);
  console.log(`Skipped (no geo data):   ${result.skippedNoGeo}`);
  console.log(`Skipped (already correct): ${result.skippedCorrect}`);
  console.log(`Errors:                  ${result.errors.length}`);
  console.log(`\nRegion distribution (desired):`);
  for (const [region, count] of Object.entries(result.regionSummary).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${region}: ${count}`);
  }
  if (dryRun) {
    console.log(`\nThis was a DRY RUN. Run with --execute to apply changes.`);
  }

  return result;
}

// Main
const args = process.argv.slice(2);
const dryRun = !args.includes('--execute');

migrateCheckRegions(dryRun)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
