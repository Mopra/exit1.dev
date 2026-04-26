export type CheckRegion = "us-central1" | "europe-west1" | "asia-southeast1" | "vps-eu-1" | "vps-us-1";

type RegionCenter = { region: CheckRegion; lat: number; lon: number };

// Very rough region centers (good enough for nearest-region selection).
// Used by pickNearestRegion() for the future auto-pick phase. Phase 1 keeps
// vps-eu-1 as the default for everyone; users on Pro+ may opt into vps-us-1
// manually via the picker.
const REGION_CENTERS: RegionCenter[] = [
  { region: "vps-eu-1", lat: 50.1109, lon: 8.6821 },          // Frankfurt, Germany (default)
  { region: "vps-us-1", lat: 42.3601, lon: -71.0589 },        // Boston, USA
  // us-central1 removed — scheduler shut down, all checks migrated to vps-eu-1
  // asia-southeast1 removed — scheduler shut down, 0 checks
];

const toRad = (deg: number) => (deg * Math.PI) / 180;

// Haversine distance in km
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

export function pickNearestRegion(lat: number | undefined, lon: number | undefined): CheckRegion {
  if (typeof lat !== "number" || typeof lon !== "number") {
    return "vps-eu-1";
  }

  let best: { region: CheckRegion; dist: number } | null = null;
  for (const c of REGION_CENTERS) {
    const dist = haversineKm(lat, lon, c.lat, c.lon);
    if (!best || dist < best.dist) {
      best = { region: c.region, dist };
    }
  }
  return best?.region ?? "vps-eu-1";
}


