import { describe, expect, it } from "vitest";
import { meterRate } from "../src/billing";
import { IP_HOURLY_USD, PLANS, chargeMicros, diskHourlyUsd, gcpHourlyUsd, planPrice, withPremium } from "../src/pricing";
import { REGION_PRICES } from "../src/regions.generated";
import { REGIONS, byAvailability, byDistance, enabledRegions, offeredRegions, regionOfZone } from "../src/regions";

describe("pricing", () => {
  it("adds the premium to the GCP cost", () => {
    expect(withPremium(1, 20)).toBe(1_200_000);
    expect(withPremium(3.6731, 20)).toBe(4_407_720);
  });

  it("prices a plan with disk and IP included", () => {
    const p = planPrice(PLANS.a100, "us-central1", 20)!;
    const disk = diskHourlyUsd("us-central1");
    expect(disk).toBeCloseTo((100 * 0.17) / 730, 9);
    expect(p.hourlyMicros).toBe(Math.round((gcpHourlyUsd("a100", "us-central1")! + disk + IP_HOURLY_USD) * 1.2 * 1e6));
    expect(p.stoppedHourlyMicros).toBe(Math.round(disk * 1.2 * 1e6));
  });

  it("matches GCP's us-central1 list prices", () => {
    expect(gcpHourlyUsd("t4", "us-central1")).toBeCloseTo(0.73, 3);
    expect(gcpHourlyUsd("l4", "us-central1")).toBeCloseTo(0.7068, 3);
    expect(gcpHourlyUsd("a100", "us-central1")).toBeCloseTo(3.6734, 3);
  });

  it("has a price for every plan in every region", () => {
    for (const r of REGIONS) for (const p of Object.values(PLANS)) expect(planPrice(p, r.id, 20), `${p.id} ${r.id}`).not.toBeNull();
    expect(planPrice(PLANS.l4, "mars-north1", 20)).toBeNull();
  });

  it("charges per second, rounding down", () => {
    expect(chargeMicros(3_600_000, 3600)).toBe(3_600_000);
    expect(chargeMicros(3_600_000, 1)).toBe(1000);
    expect(chargeMicros(1_000_000, 1)).toBe(277);
    expect(chargeMicros(1_000_000, 0)).toBe(0);
    expect(chargeMicros(1_000_000, -5)).toBe(0);
  });

  it("prices Spot plans (H100) at GCP's Spot price and the rest on-demand", () => {
    expect(PLANS.h100.spot).toBe(true);
    expect(gcpHourlyUsd("h100", "asia-east1")).toBe(REGION_PRICES["asia-east1"].spot.h100);
    expect(gcpHourlyUsd("h100", "asia-east1")!).toBeLessThan(REGION_PRICES["asia-east1"].plans.h100);
    expect(planPrice(PLANS.h100, "asia-east1", 20)!.hourlyMicros).toBeCloseTo(9.19e6, -4);
    expect(gcpHourlyUsd("a100", "us-central1")).toBe(REGION_PRICES["us-central1"].plans.a100);
  });

  it("offers H100 only where GCP granted quota (Taiwan)", () => {
    expect(PLANS.h100.available).toBe(true);
    expect(offeredRegions("", "h100").map((r) => r.id)).toEqual(["asia-east1"]);
  });

  it("$10 buys about two hours of A100", () => {
    const hours = 10e6 / planPrice(PLANS.a100, "us-central1", 20)!.hourlyMicros;
    expect(hours).toBeGreaterThan(2);
    expect(hours).toBeLessThan(2.5);
  });
});

describe("regions", () => {
  const ids = (rs: { id: string }[]) => rs.map((r) => r.id);
  it("orders regions nearest first", () => {
    const all = enabledRegions("");
    expect(ids(byDistance(all, 52.37, 4.9))[0]).toBe("europe-west4"); // Amsterdam
    expect(ids(byDistance(all, 35.68, 139.69))[0]).toBe("asia-east1"); // Tokyo -> Taiwan
    expect(ids(byDistance(all, 37.77, -122.42))[0]).toBe("us-west1"); // San Francisco
    expect(ids(byDistance(all, 40.71, -74.0))[0]).toBe("us-east1"); // New York
    expect(ids(byDistance(all, 41.88, -87.63))[0]).toBe("us-central1"); // Chicago
    expect(ids(byDistance(all, 23.81, 90.41)).slice(0, 2)).toEqual(["asia-southeast1", "asia-east1"]); // Dhaka
  });
  it("offers a plan only where it has a zone and quota", () => {
    // Taiwan has an A100 price but no zone with the machine.
    expect(ids(offeredRegions("", "a100"))).not.toContain("asia-east1");
    expect(ids(offeredRegions("", "l4"))).toContain("asia-east1");
  });

  it("tries regions with GPUs to spare first, nearest first, then full ones", () => {
    const a100 = offeredRegions("", "a100");
    const chicago = [41.88, -87.63] as const;
    // Nothing in use: plain nearest first.
    expect(ids(byAvailability(a100, "a100", {}, ...chicago))[0]).toBe("us-central1");
    // us-central1's 4 A100s all taken: it moves behind every region with room.
    const full = ids(byAvailability(a100, "a100", { "us-central1": 4 }, ...chicago));
    expect(full[0]).not.toBe("us-central1");
    expect(full[full.length - 1]).toBe("us-central1");
    // H100 has one region; it's always tried, full or not.
    expect(ids(byAvailability(offeredRegions("", "h100"), "h100", { "asia-east1": 30 }, ...chicago))).toEqual(["asia-east1"]);
  });

  it("leads with the fallback region when the location is unknown", () => {
    expect(ids(byDistance(enabledRegions(""), undefined, undefined))[0]).toBe("us-central1");
  });
  it("honours the REGIONS setting", () => {
    expect(ids(enabledRegions("us-east1, europe-west4"))).toEqual(["us-east1", "europe-west4"]);
    expect(enabledRegions("", "l4")).toHaveLength(REGIONS.length);
    expect(enabledRegions("", "no-such-plan")).toHaveLength(0);
  });
  it("finds a zone's region", () => {
    expect(regionOfZone("europe-west4-b")).toBe("europe-west4");
  });
});

describe("meterRate", () => {
  const base = { hourly_micros: 1000, stopped_hourly_micros: 10, metered_until: 1, stopped_at: null };
  it("bills nothing before the VM exists", () => {
    expect(meterRate({ ...base, status: "pending", metered_until: null })).toBe(0);
    expect(meterRate({ ...base, status: "running", metered_until: null })).toBe(0);
  });
  it("bills the full rate while running, stopping or destroying a running VM", () => {
    for (const status of ["running", "stopping", "destroying", "failed"] as const) {
      expect(meterRate({ ...base, status })).toBe(1000);
    }
  });
  it("bills only the disk while stopped", () => {
    expect(meterRate({ ...base, status: "stopped", stopped_at: 5 })).toBe(10);
    expect(meterRate({ ...base, status: "starting", stopped_at: 5 })).toBe(10);
    expect(meterRate({ ...base, status: "destroying", stopped_at: 5 })).toBe(10);
  });
  it("bills nothing once destroyed", () => {
    expect(meterRate({ ...base, status: "destroyed" })).toBe(0);
  });
});
