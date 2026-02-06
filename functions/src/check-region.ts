export type CheckRegion = "us-central1" | "europe-west1" | "asia-southeast1";

type RegionCenter = { region: CheckRegion; lat: number; lon: number };

// Very rough region centers (good enough for nearest-region selection)
const REGION_CENTERS: RegionCenter[] = [
  { region: "us-central1", lat: 41.8781, lon: -93.0977 },     // Iowa, USA
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


