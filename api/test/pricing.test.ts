import { describe, expect, it } from "vitest";
import { meterRate } from "../src/billing";
import { DISK_HOURLY_USD, IP_HOURLY_USD, PLANS, chargeMicros, planPrice, withPremium } from "../src/pricing";

describe("pricing", () => {
  it("adds the premium to the GCP cost", () => {
    expect(withPremium(1, 20)).toBe(1_200_000);
    expect(withPremium(3.6731, 20)).toBe(4_407_720);
  });

  it("prices a plan with disk and IP included", () => {
    const p = planPrice(PLANS.a100, 20);
    expect(p.hourlyMicros).toBe(Math.round((3.6731 + DISK_HOURLY_USD + IP_HOURLY_USD) * 1.2 * 1e6));
    expect(p.stoppedHourlyMicros).toBe(Math.round(DISK_HOURLY_USD * 1.2 * 1e6));
  });

  it("charges per second, rounding down", () => {
    expect(chargeMicros(3_600_000, 3600)).toBe(3_600_000);
    expect(chargeMicros(3_600_000, 1)).toBe(1000);
    expect(chargeMicros(1_000_000, 1)).toBe(277);
    expect(chargeMicros(1_000_000, 0)).toBe(0);
    expect(chargeMicros(1_000_000, -5)).toBe(0);
  });

  it("$10 buys about two hours of A100", () => {
    const hours = 10e6 / planPrice(PLANS.a100, 20).hourlyMicros;
    expect(hours).toBeGreaterThan(2);
    expect(hours).toBeLessThan(2.5);
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
