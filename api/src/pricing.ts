// What a box costs us on GCP, and what we charge for it.
//
// gcpHourlyUsd is the on-demand list price in us-central1 for the machine
// (and attached GPU). Check it against https://cloud.google.com/compute/gpus-pricing
// and https://cloud.google.com/compute/vm-instance-pricing when changing plans
// or regions; GCP does not bill us through this table.

export interface Plan {
  id: string;
  label: string;
  machineType: string;
  gpuType: string; // "" when the machine type has the GPU built in (A2, G2)
  gpuCount: number;
  gcpHourlyUsd: number;
}

export const PLANS: Record<string, Plan> = {
  t4: {
    id: "t4",
    label: "1x NVIDIA T4 16 GB, 8 vCPU, 30 GB RAM",
    machineType: "n1-standard-8",
    gpuType: "nvidia-tesla-t4",
    gpuCount: 1,
    gcpHourlyUsd: 0.38 + 0.35,
  },
  l4: {
    id: "l4",
    label: "1x NVIDIA L4 24 GB, 4 vCPU, 16 GB RAM",
    machineType: "g2-standard-4",
    gpuType: "",
    gpuCount: 0,
    gcpHourlyUsd: 0.7068,
  },
  a100: {
    id: "a100",
    label: "1x NVIDIA A100 40 GB, 12 vCPU, 85 GB RAM",
    machineType: "a2-highgpu-1g",
    gpuType: "",
    gpuCount: 0,
    gcpHourlyUsd: 3.6731,
  },
  "a100-80": {
    id: "a100-80",
    label: "1x NVIDIA A100 80 GB, 12 vCPU, 170 GB RAM",
    machineType: "a2-ultragpu-1g",
    gpuType: "",
    gpuCount: 0,
    gcpHourlyUsd: 5.0688,
  },
};

export const DEFAULT_PLAN = "a100";

// Every box has a 100 GB pd-ssd boot disk ($0.17/GB-month) and, while
// running, an ephemeral external IPv4 ($0.005/hour).
export const DISK_HOURLY_USD = (100 * 0.17) / 730;
export const IP_HOURLY_USD = 0.005;

export function withPremium(costUsd: number, premiumPct: number): number {
  return Math.round(costUsd * (1 + premiumPct / 100) * 1e6);
}

// Price per hour, in micro-dollars, while the box runs and while it's stopped
// (when only its disk is billed).
export function planPrice(plan: Plan, premiumPct: number) {
  return {
    hourlyMicros: withPremium(plan.gcpHourlyUsd + DISK_HOURLY_USD + IP_HOURLY_USD, premiumPct),
    stoppedHourlyMicros: withPremium(DISK_HOURLY_USD, premiumPct),
  };
}

// Charge for `seconds` at an hourly rate, rounded down to the micro-dollar.
export function chargeMicros(hourlyMicros: number, seconds: number): number {
  if (seconds <= 0 || hourlyMicros <= 0) return 0;
  return Math.floor((hourlyMicros * seconds) / 3600);
}
