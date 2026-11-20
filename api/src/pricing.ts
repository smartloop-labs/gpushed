// What a box costs us on GCP, and what we charge for it.
//
// GCP prices differ by region; the per-region list prices are generated into
// regions.generated.ts by scripts/gcp-prices.mjs from the Cloud Billing
// Catalog. A box is priced at the region it actually runs in, at the Spot
// price for a Spot plan.

import { REGION_PRICES } from "./regions.generated";

export interface Plan {
  id: string;
  // The GPU's entry in the generated price and zone tables (regions.generated.ts,
  // zones.generated.ts): a plan and its Spot variant share it. Quota is per plan
  // (capacity.generated.ts), since GCP counts Spot GPUs separately.
  gpu: string;
  label: string;
  machineType: string;
  gpuType: string; // "" when the machine type has the GPU built in (A2, G2)
  gpuCount: number;
  // False while GCP hasn't granted us quota for it: listed in `gpushed plans`
  // with its price, but a box can't be created on it yet.
  available: boolean;
  // Runs as a GCP Spot VM: cheaper, but Google may reclaim it at any time.
  // A reclaimed box is stopped with its disk kept (Terraform's
  // instance_termination_action), and its shutdown hook tells the API.
  spot?: boolean;
}

// The machine each plan runs on. scripts/gcp-prices.mjs has the same plans
// broken into cores, RAM and GPU for pricing; keep them in step.
const ON_DEMAND: Plan[] = [
  {
    id: "t4",
    gpu: "t4",
    label: "1x NVIDIA Tesla T4 16 GB, 8 vCPU, 30 GB RAM",
    machineType: "n1-standard-8",
    gpuType: "nvidia-tesla-t4",
    gpuCount: 1,
    available: true,
  },
  {
    id: "l4",
    gpu: "l4",
    label: "1x NVIDIA L4 24 GB, 4 vCPU, 16 GB RAM",
    machineType: "g2-standard-4",
    gpuType: "",
    gpuCount: 0,
    available: true,
  },
  {
    id: "a100",
    gpu: "a100",
    label: "1x NVIDIA A100 40 GB, 12 vCPU, 85 GB RAM",
    machineType: "a2-highgpu-1g",
    gpuType: "",
    gpuCount: 0,
    available: true,
  },
];

// Every on-demand plan also comes as "<id>-spot": the same machine as a Spot
// VM, at GCP's Spot price.
const SPOT: Plan[] = ON_DEMAND.map((p) => ({ ...p, id: `${p.id}-spot`, spot: true }));

export const PLANS: Record<string, Plan> = Object.fromEntries(
  [
    ...ON_DEMAND,
    ...SPOT,
    // GCP creates a3-highgpu-1g (and -2g, -4g) only as Spot or Flex-start, never
    // on-demand, so H100 boxes are Spot (and there's no plain "h100-spot").
    // Offered in asia-east1 only, where the H100 family quota is granted
    // (capacity.generated.ts).
    {
      id: "h100",
      gpu: "h100",
      label: "1x NVIDIA H100 80 GB, 26 vCPU, 234 GB RAM",
      machineType: "a3-highgpu-1g",
      gpuType: "",
      gpuCount: 0,
      available: true,
      spot: true,
    },
  ].map((p) => [p.id, p]),
);

// Not offered until GCP grants NVIDIA_A100_80GB_GPUS quota (it's 0 in our
// project); add it to ON_DEMAND then (its prices are already generated):
//
//   {
//     id: "a100-80",
//     gpu: "a100-80",
//     label: "1x NVIDIA A100 80 GB, 12 vCPU, 170 GB RAM",
//     machineType: "a2-ultragpu-1g",
//     gpuType: "",
//     gpuCount: 0,
//     available: true,
//   },

// Spot by default: much cheaper, and a reclaimed box keeps its disk. Plans
// without "-spot" are on-demand, for work that mustn't be interrupted.
export const DEFAULT_PLAN = "l4-spot";

// What zone stockouts are recorded under: Spot and on-demand capacity of a
// machine type run out separately.
export function capacityKey(plan: Plan): string {
  return plan.spot ? `${plan.machineType}:spot` : plan.machineType;
}

// Every box has a 100 GB pd-ssd boot disk and, while running, an ephemeral
// external IPv4 ($0.005/hour in every region).
export const DISK_GB = 100;
export const IP_HOURLY_USD = 0.005;
const HOURS_PER_MONTH = 730;

export function withPremium(costUsd: number, premiumPct: number): number {
  return Math.round(costUsd * (1 + premiumPct / 100) * 1e6);
}

// GCP's hourly cost of running a plan in a region (its Spot price for a Spot
// plan), or null if it isn't sold there.
export function gcpHourlyUsd(planId: string, region: string): number | null {
  const plan = PLANS[planId];
  if (!plan) return null;
  const prices = REGION_PRICES[region];
  return (plan.spot ? prices?.spot[plan.gpu] : prices?.plans[plan.gpu]) ?? null;
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
