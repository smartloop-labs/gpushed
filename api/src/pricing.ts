// What a box costs us on GCP, and what we charge for it.
//
// GCP prices differ by region; the per-region list prices are generated into
// regions.generated.ts by scripts/gcp-prices.mjs from the Cloud Billing
// Catalog. A box is priced at the region it actually runs in.

import { REGION_PRICES } from "./regions.generated";

export interface Plan {
  id: string;
  label: string;
  machineType: string;
  gpuType: string; // "" when the machine type has the GPU built in (A2, G2)
  gpuCount: number;
}

// The machine each plan runs on. scripts/gcp-prices.mjs has the same plans
// broken into cores, RAM and GPU for pricing; keep them in step.
export const PLANS: Record<string, Plan> = {
  t4: {
    id: "t4",
    label: "1x NVIDIA Tesla T4 16 GB, 8 vCPU, 30 GB RAM",
    machineType: "n1-standard-8",
    gpuType: "nvidia-tesla-t4",
    gpuCount: 1,
  },
  l4: {
    id: "l4",
    label: "1x NVIDIA L4 24 GB, 4 vCPU, 16 GB RAM",
    machineType: "g2-standard-4",
    gpuType: "",
    gpuCount: 0,
  },
  a100: {
    id: "a100",
    label: "1x NVIDIA A100 40 GB, 12 vCPU, 85 GB RAM",
    machineType: "a2-highgpu-1g",
    gpuType: "",
    gpuCount: 0,
  },
};

// Not offered until GCP grants NVIDIA_A100_80GB_GPUS quota (it's 0 in our
// project); add it back to PLANS then (its prices are already generated):
//
//   "a100-80": {
//     id: "a100-80",
//     label: "1x NVIDIA A100 80 GB, 12 vCPU, 170 GB RAM",
//     machineType: "a2-ultragpu-1g",
//     gpuType: "",
//     gpuCount: 0,
//   },

export const DEFAULT_PLAN = "l4";

// Every box has a 100 GB pd-ssd boot disk and, while running, an ephemeral
// external IPv4 ($0.005/hour in every region).
export const DISK_GB = 100;
export const IP_HOURLY_USD = 0.005;
const HOURS_PER_MONTH = 730;

export function withPremium(costUsd: number, premiumPct: number): number {
  return Math.round(costUsd * (1 + premiumPct / 100) * 1e6);
}

// GCP's hourly cost of running a plan in a region, or null if it isn't sold there.
export function gcpHourlyUsd(planId: string, region: string): number | null {
  return REGION_PRICES[region]?.plans[planId] ?? null;
}

export function diskHourlyUsd(region: string): number {
  return (DISK_GB * (REGION_PRICES[region]?.ssdGbMonth ?? 0.17)) / HOURS_PER_MONTH;
}

// Price per hour, in micro-dollars, while the box runs and while it's stopped
// (when only its disk is billed). Null if the plan isn't sold in the region.
export function planPrice(plan: Plan, region: string, premiumPct: number) {
  const gcp = gcpHourlyUsd(plan.id, region);
  if (gcp == null) return null;
  const disk = diskHourlyUsd(region);
  return {
    hourlyMicros: withPremium(gcp + disk + IP_HOURLY_USD, premiumPct),
    stoppedHourlyMicros: withPremium(disk, premiumPct),
  };
}

// Charge for `seconds` at an hourly rate, rounded down to the micro-dollar.
export function chargeMicros(hourlyMicros: number, seconds: number): number {
  if (seconds <= 0 || hourlyMicros <= 0) return 0;
  return Math.floor((hourlyMicros * seconds) / 3600);
}
