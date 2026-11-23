import { afterEach, describe, expect, it, vi } from "vitest";
import { type Box, deleteLongStopped, deletesAt, stoppedMaxHours } from "../src/billing";
import type { Env } from "../src/env";

const NOW = 1_800_000_000;

function box(over: Partial<Box> = {}): Box {
  return {
    id: "b1",
    user_id: "u1",
    plan: "l4",
    status: "stopped",
    region: "us-central1",
    regions: "us-central1",
    zone: "us-central1-b",
    ip: null,
    ssh_public_key: "ssh-ed25519 AAAA",
    hourly_micros: 1_000_000,
    stopped_hourly_micros: 28_000,
    metered_until: NOW,
    stopped_at: NOW - 7 * 3600,
    error: null,
    progress: null,
    created_at: NOW - 86_400,
    updated_at: NOW - 7 * 3600,
    ...over,
  };
}

// A D1 stand-in that records every statement and answers SELECTs with `rows`.
function fakeEnv(rows: (Box & { email: string })[], vars: Partial<Env> = {}) {
  const runs: { sql: string; args: unknown[] }[] = [];
  const env = {
    DEV: "1", // log the dispatch and email instead of sending them
    PROVISIONER: "github",
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind: (...a: unknown[]) => ((args = a), stmt),
          run: async () => (runs.push({ sql, args }), {}),
          all: async () => (runs.push({ sql, args }), { results: rows }),
          first: async () => (runs.push({ sql, args }), sql.includes("RETURNING") ? { ...rows[0], status: "destroying" } : null),
        };
        return stmt;
      },
    },
    ...vars,
  } as unknown as Env;
  return { env, runs };
}

afterEach(() => vi.restoreAllMocks());

describe("STOPPED_MAX_HOURS", () => {
  it("defaults to 24 and ignores a non-positive value", () => {
    expect(stoppedMaxHours({} as Env)).toBe(24);
    expect(stoppedMaxHours({ STOPPED_MAX_HOURS: "6" } as Env)).toBe(6);
    expect(stoppedMaxHours({ STOPPED_MAX_HOURS: "0" } as Env)).toBe(24);
  });

  it("gives a stopped box its deletion time, and no other box one", () => {
    const env = { STOPPED_MAX_HOURS: "6" } as Env;
    expect(deletesAt(env, box({ stopped_at: NOW }))).toBe(NOW + 6 * 3600);
    expect(deletesAt(env, box({ status: "running", stopped_at: null }))).toBeNull();
  });

  it("selects boxes stopped longer than the limit and dispatches their deletion", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { env, runs } = fakeEnv([{ ...box(), email: "a@example.com" }], { STOPPED_MAX_HOURS: "6" });
    await deleteLongStopped(env, NOW);
    expect(runs[0].sql).toMatch(/b\.status = 'stopped'/);
    expect(runs[0].args).toEqual([NOW - 6 * 3600]);
    expect(runs.some((r) => /UPDATE boxes/.test(r.sql) && r.args.includes("destroying"))).toBe(true);
  });
});
