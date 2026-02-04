export type CheckRegion =
  | "us-central1"
  | "us-east4"
  | "us-west1"
  | "europe-west1"
  | "asia-southeast1";

type RegionCenter = { region: CheckRegion; lat: number; lon: number };

// Very rough region centers (good enough for nearest-region selection)
// NOTE: europe-west2, europe-west3, europe-north1 were removed because
// Cloud Run failed to initialize in those regions (quota exceeded).
// All EU checks route through europe-west1 (Belgium) for now.
const REGION_CENTERS: RegionCenter[] = [
  { region: "us-central1", lat: 41.8781, lon: -93.0977 },     // Iowa, USA
  { region: "us-east4", lat: 38.13, lon: -78.45 },            // Virginia, USA
  { region: "us-west1", lat: 45.59, lon: -122.60 },           // Oregon, USA
  { region: "europe-west1", lat: 50.4561, lon: 3.8247 },      // Belgium
  { region: "asia-southeast1", lat: 1.3521, lon: 103.8198 },  // Singapore
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
    return "us-central1";
  }

  let best: { region: CheckRegion; dist: number } | null = null;
  for (const c of REGION_CENTERS) {
    const dist = haversineKm(lat, lon, c.lat, c.lon);
    if (!best || dist < best.dist) {
      best = { region: c.region, dist };
    }
  }
  return best?.region ?? "us-central1";
}


