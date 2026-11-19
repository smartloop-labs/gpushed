// The GCP regions boxes can run in, and how to pick one for a user.
//
// A plan is offered in a region that has its price, a zone with its machine,
// and GPU quota for it (capacity.generated.ts). A new box tries first the
// regions with quota to spare (not taken by our live boxes), nearest the user
// first (Cloudflare's estimate of where the request came from), then the
// full ones, in case the quota table is stale. Zones that just ran out of the
// machine are tried last within a region (zone_stockouts). Each region needs
// a subnet (infra/bootstrap), and entries in the generated tables.

import { PLAN_CAPACITY } from "./capacity.generated";
import { REGION_PRICES } from "./regions.generated";
import { PLAN_ZONES } from "./zones.generated";

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
  { id: "asia-east1", name: "Taiwan", lat: 24.05, lon: 120.52 },
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

// GPUs of the plan our project may run in the region (its GCP quota).
export function capacity(planId: string, regionId: string): number {
  return PLAN_CAPACITY[planId]?.[regionId] ?? 0;
}

// Enabled regions where a new box of the plan can go: priced, with a zone
// offering its machine, and with GPU quota for it.
export function offeredRegions(enabled: string | undefined, planId: string): Region[] {
  return enabledRegions(enabled, planId).filter(
    (r) => (PLAN_ZONES[planId]?.[r.id] ?? []).length > 0 && capacity(planId, r.id) > 0,
  );
}

// The order to try regions for a new box of the plan: those with GPUs to
// spare first (quota less what `inUse` says our live boxes hold there), then
// the full ones; nearest first within each.
export function byAvailability(
  regions: Region[],
  planId: string,
  inUse: Record<string, number>,
  lat?: number,
  lon?: number,
): Region[] {
  const spare = (r: Region) => capacity(planId, r.id) - (inUse[r.id] ?? 0) > 0;
  const near = byDistance(regions, lat, lon);
  return [...near.filter(spare), ...near.filter((r) => !spare(r))];
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
