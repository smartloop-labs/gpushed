// The GCP regions boxes can run in, and how to pick one for a user.
//
// A new box goes to the region nearest the user (from Cloudflare's estimate
// of where the request came from), then the next nearest, and so on, until
// one has GPU capacity. Each region needs a subnet (infra/bootstrap), GPU
// quota, and prices in regions.generated.ts.

import { REGION_PRICES } from "./regions.generated";

export interface Region {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export const REGIONS: Region[] = [
  { id: "us-central1", name: "Iowa, USA", lat: 41.26, lon: -95.86 },
  { id: "us-east1", name: "South Carolina, USA", lat: 33.2, lon: -80.01 },
  { id: "us-west1", name: "Oregon, USA", lat: 45.6, lon: -121.18 },
  { id: "europe-west4", name: "Netherlands", lat: 53.44, lon: 6.84 },
  { id: "asia-southeast1", name: "Singapore", lat: 1.35, lon: 103.82 },
];

// Used when we can't tell where a request came from.
export const FALLBACK_REGION = "us-central1";

// Great-circle distance in km.
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// Regions enabled for this deployment (env REGIONS, comma-separated; default all)
// that sell the plan.
export function enabledRegions(enabled: string | undefined, planId?: string): Region[] {
  const allow = (enabled ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return REGIONS.filter(
    (r) => (allow.length === 0 || allow.includes(r.id)) && (!planId || REGION_PRICES[r.id]?.plans[planId] != null),
  );
}

// Regions nearest first. Without a location, the fallback region leads and
// the rest keep their listed order.
export function byDistance(regions: Region[], lat?: number, lon?: number): Region[] {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return [...regions].sort((a, b) => Number(b.id === FALLBACK_REGION) - Number(a.id === FALLBACK_REGION));
  }
  return [...regions].sort((a, b) => distanceKm(lat, lon, a.lat, a.lon) - distanceKm(lat, lon, b.lat, b.lon));
}

// Where Cloudflare thinks the request came from.
export function requestLocation(req: Request): { lat?: number; lon?: number; country?: string } {
  const cf = (req as Request & { cf?: { latitude?: string; longitude?: string; country?: string } }).cf;
  return {
    lat: cf?.latitude != null ? Number(cf.latitude) : undefined,
    lon: cf?.longitude != null ? Number(cf.longitude) : undefined,
    country: cf?.country,
  };
}

// "us-central1-b" -> "us-central1"
export function regionOfZone(zone: string): string {
  return zone.replace(/-[a-z]$/, "");
}
