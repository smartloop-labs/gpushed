import { describe, expect, it } from "vitest";
import { PLANS } from "../src/pricing";
import { REGIONS, planZones, regionOfZone } from "../src/regions";
import { PLAN_ZONES } from "../src/zones.generated";

// zones.generated.ts must cover every plan and region, or new boxes fall back
// to the provisioner's slow zone lookup. Regenerate with scripts/gcp-zones.mjs.
describe("PLAN_ZONES", () => {
  it("has zones for every plan's GPU", () => {
    for (const p of Object.values(PLANS)) {
      expect(Object.values(PLAN_ZONES[p.gpu] ?? {}).flat().length, p.id).toBeGreaterThan(0);
    }
  });

  it("gives a Spot plan its GPU's zones", () => {
    expect(planZones("l4-ondemand", "us-central1")).toEqual(PLAN_ZONES.l4["us-central1"]);
  });

  it("covers every region, with each zone in its own region", () => {
    for (const p of Object.values(PLANS)) {
      for (const r of REGIONS) {
        const zones = PLAN_ZONES[p.gpu][r.id];
        expect(zones, `${p.id} ${r.id}`).toBeDefined();
        for (const z of zones) expect(regionOfZone(z)).toBe(r.id);
      }
    }
  });
});
