import { describe, expect, it } from "vitest";
import { PLANS } from "../src/pricing";
import { REGIONS, regionOfZone } from "../src/regions";
import { PLAN_ZONES } from "../src/zones.generated";

// zones.generated.ts must cover every plan and region, or new boxes fall back
// to the provisioner's slow zone lookup. Regenerate with scripts/gcp-zones.mjs.
describe("PLAN_ZONES", () => {
  it("has zones for every plan", () => {
    for (const id of Object.keys(PLANS)) {
      expect(Object.values(PLAN_ZONES[id] ?? {}).flat().length, id).toBeGreaterThan(0);
    }
  });

  it("covers every region, with each zone in its own region", () => {
    for (const id of Object.keys(PLANS)) {
      for (const r of REGIONS) {
        const zones = PLAN_ZONES[id][r.id];
        expect(zones, `${id} ${r.id}`).toBeDefined();
        for (const z of zones) expect(regionOfZone(z)).toBe(r.id);
      }
    }
  });
});
