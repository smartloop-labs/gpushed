#!/usr/bin/env node
// Regenerate src/regions.generated.ts: GCP's on-demand and Spot list prices
// for each plan in each region, from the Cloud Billing Catalog API (the same prices
// GCP bills us). Run it when adding a region or a plan, or to pick up a GCP
// price change:
//
//   node scripts/gcp-prices.mjs <gcp-project-for-quota>
//
// Needs `gcloud` signed in, and the Cloud Billing API enabled in that project.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const REGIONS = ["us-central1", "us-east1", "us-west1", "europe-west4", "asia-southeast1", "asia-east1"];

// What each plan's machine is made of; GCP bills cores, RAM and the GPU
// separately. Keep in step with PLANS in src/pricing.ts.
const PLANS = {
  t4: { family: "N1 Predefined Instance", vcpu: 8, ramGb: 30, gpu: "Nvidia Tesla T4 GPU" },
  l4: { family: "G2 Instance", vcpu: 4, ramGb: 16, gpu: "Nvidia L4 GPU" },
  a100: { family: "A2 Instance", vcpu: 12, ramGb: 85, gpu: "Nvidia Tesla A100 GPU" },
  "a100-80": { family: "A2 Instance", vcpu: 12, ramGb: 170, gpu: "Nvidia Tesla A100 80GB GPU" },
  h100: { family: "A3 Instance", vcpu: 26, ramGb: 234, gpu: "Nvidia H100 80GB GPU" },
  rtx6000: { family: "G4 Instance", vcpu: 48, ramGb: 180, gpu: "RTX 6000 96GB" },
};

const COMPUTE = "6F81-5844-456A"; // Compute Engine's service id in the catalog
const quotaProject = process.argv[2];
if (!quotaProject) {
  console.error("usage: node scripts/gcp-prices.mjs <gcp-project-for-quota>");
  process.exit(2);
}

const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8" }).trim();

async function allSkus() {
  const skus = [];
  let pageToken = "";
  do {
    const url = `https://cloudbilling.googleapis.com/v1/services/${COMPUTE}/skus?pageSize=5000&currencyCode=USD${pageToken ? `&pageToken=${pageToken}` : ""}`;
    let res;
    for (let attempt = 1; ; attempt++) {
      res = await fetch(url, { headers: { authorization: `Bearer ${token}`, "x-goog-user-project": quotaProject } });
      if (res.ok || attempt === 5) break;
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
    if (!res.ok) throw new Error(`catalog request failed: ${res.status} ${await res.text()}`);
    const page = await res.json();
    skus.push(...(page.skus ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return skus;
}

const EXCLUDE = /commit|dws|reserv|calendar|sole tenancy|custom|flex/i;
// Spot SKUs say "Spot Preemptible"; on-demand ones never mention either.
const SPOT = /spot|preemptible/i;

function unitPrice(sku) {
  const rates = sku.pricingInfo[0].pricingExpression.tieredRates;
  const r = rates[rates.length - 1].unitPrice; // on-demand compute SKUs have one tier
  return Number(r.units ?? 0) + (r.nanos ?? 0) / 1e9;
}

// The single on-demand (or Spot) SKU whose description matches and that serves region.
function price(skus, region, re, unit, spot = false) {
  const found = skus.filter(
    (s) =>
      s.category?.usageType === (spot ? "Preemptible" : "OnDemand") &&
      SPOT.test(s.description) === spot &&
      s.serviceRegions?.includes(region) &&
      re.test(s.description.replace(/^Spot Preemptible /, "")) &&
      !EXCLUDE.test(s.description) &&
      s.pricingInfo?.[0]?.pricingExpression?.usageUnit === unit,
  );
  if (found.length === 0) return null;
  // Prefer the most specific SKU (fewest regions), then check it's unambiguous.
  found.sort((a, b) => a.serviceRegions.length - b.serviceRegions.length);
  const best = found.filter((s) => s.serviceRegions.length === found[0].serviceRegions.length);
  const prices = [...new Set(best.map(unitPrice))];
  if (prices.length > 1) throw new Error(`${region}: ambiguous SKUs for ${re}: ${best.map((s) => s.description).join("; ")}`);
  return prices[0];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Cores + RAM + GPU per hour, or null if the plan isn't sold in the region.
// Spot GPU SKUs read "<gpu> attached to Spot Preemptible VMs running in ...".
function planHourly(skus, region, p, spot) {
  const core = price(skus, region, new RegExp(`^${esc(p.family)} Core running in `), "h", spot);
  const ram = price(skus, region, new RegExp(`^${esc(p.family)} Ram running in `), "GiBy.h", spot);
  const gpu = price(skus, region, new RegExp(`^${esc(p.gpu)} (attached to Spot Preemptible VMs )?running in `), "h", spot);
  if (core == null || ram == null || gpu == null) return null;
  return Math.round((core * p.vcpu + ram * p.ramGb + gpu) * 1e6) / 1e6;
}

const skus = await allSkus();
const out = {};
for (const region of REGIONS) {
  const r = { plans: {}, spot: {}, ssdGbMonth: price(skus, region, /^SSD backed PD Capacity/, "GiBy.mo") };
  if (r.ssdGbMonth == null) throw new Error(`${region}: no pd-ssd price`);
  for (const [id, p] of Object.entries(PLANS)) {
    const onDemand = planHourly(skus, region, p, false);
    if (onDemand == null) continue; // not sold in this region
    r.plans[id] = onDemand;
    const spot = planHourly(skus, region, p, true);
    if (spot != null) r.spot[id] = spot;
  }
  out[region] = r;
  console.error(region, JSON.stringify(r));
}

writeFileSync(
  new URL("../src/regions.generated.ts", import.meta.url),
  `// Generated by scripts/gcp-prices.mjs from the Cloud Billing Catalog on ${new Date().toISOString().slice(0, 10)}.
// Do not edit by hand. GCP list prices in USD: plans (on-demand) and spot are
// per hour (cores + RAM + GPU), ssdGbMonth is pd-ssd per GB-month.

export const REGION_PRICES: Record<string, { plans: Record<string, number>; spot: Record<string, number>; ssdGbMonth: number }> = ${JSON.stringify(out, null, 2)};
`,
);
