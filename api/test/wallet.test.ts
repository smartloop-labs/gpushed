import { afterEach, describe, expect, it, vi } from "vitest";
import { type Box, ensureMigrated, meterBox, syncBalance } from "../src/billing";
import type { Env } from "../src/env";

const NOW = 1_800_000_000;

function box(over: Partial<Box> = {}): Box {
  return {
    id: "b1",
    user_id: "u1",
    plan: "l4",
    status: "running",
    region: "us-central1",
    regions: "us-central1",
    zone: "us-central1-b",
    ip: null,
    ssh_public_key: "ssh-ed25519 AAAA",
    hourly_micros: 3_600_000, // $3.60/h = $0.001/s
    stopped_hourly_micros: 28_000,
    metered_until: NOW - 600, // ten minutes to bill
    stopped_at: null,
    error: null,
    progress: null,
    created_at: NOW - 86_400,
    updated_at: NOW - 600,
    ...over,
  };
}

// D1 stand-in: records statements; first() answers from `user`.
function fakeEnv(user: { balance_micros: number; wallet_migrated_at: number | null }) {
  const runs: { sql: string; args: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind: (...a: unknown[]) => ((args = a), stmt),
          run: async () => (runs.push({ sql, args }), {}),
          first: async () => (runs.push({ sql, args }), user),
          all: async () => (runs.push({ sql, args }), { results: [] }),
          get sql() {
            return sql;
          },
          get args() {
            return args;
          },
        };
        return stmt;
      },
      batch: async (stmts: { sql: string; args: unknown[] }[]) => {
        for (const s of stmts) runs.push({ sql: s.sql, args: s.args });
        return [];
      },
    },
    SMARTLOOP_API: "https://api.test",
    SMARTLOOP_SERVICE_SECRET: "svc",
    LOW_BALANCE_USD: "2",
  } as unknown as Env;
  return { env, runs };
}

// The smartloop API: records calls, answers spend/credits/grant.
function stubSmartloop(available = 5_000_000) {
  const calls: { path: string; body: any; secret: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body, secret: new Headers(init.headers).get("x-service-secret") });
    if (path.endsWith("/credits/spend")) {
      return Response.json({
        from_plan_micros: body.amount_micros,
        from_wallet_micros: 0,
        short_micros: 0,
        replayed: false,
        plan_micros: 0,
        wallet_micros: available,
        available_micros: available,
      });
    }
    if (path.endsWith("/credits/grant")) return Response.json({ applied: true, wallet_micros: available });
    return Response.json({ plan_micros: 0, wallet_micros: available, available_micros: available });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("meterBox", () => {
  it("spends the window through smartloop, once per window, and stores what's left", async () => {
    const calls = stubSmartloop(4_400_000);
    const { env, runs } = fakeEnv({ balance_micros: 0, wallet_migrated_at: NOW - 10 });
    await meterBox(env, box(), NOW);

    const spend = calls.find((c) => c.path === "/v1/internal/credits/spend")!;
    expect(spend.secret).toBe("svc");
    expect(spend.body).toEqual({ user_id: "u1", amount_micros: 600_000, ref: `usage:b1:${NOW - 600}` });
    // History row on the same ref, the window advanced, the copy refreshed.
    expect(runs.some((r) => /INSERT INTO ledger/.test(r.sql) && r.args[2] === `usage:b1:${NOW - 600}`)).toBe(true);
    expect(runs.some((r) => /UPDATE boxes SET metered_until/.test(r.sql))).toBe(true);
    const sync = runs.find((r) => /UPDATE users SET balance_micros = \?1/.test(r.sql))!;
    expect(sync.args[0]).toBe(4_400_000);
  });

  it("doesn't charge or advance when smartloop can't be reached, so the next run retries", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 502 }));
    const { env, runs } = fakeEnv({ balance_micros: 0, wallet_migrated_at: NOW - 10 });
    await expect(meterBox(env, box(), NOW)).rejects.toThrow(/HTTP 502/);
    expect(runs.some((r) => /UPDATE boxes SET metered_until/.test(r.sql))).toBe(false);
    expect(runs.some((r) => /INSERT INTO ledger/.test(r.sql))).toBe(false);
  });
});

describe("ensureMigrated", () => {
  it("moves the old balance into the wallet once, then marks the account", async () => {
    const calls = stubSmartloop();
    const { env, runs } = fakeEnv({ balance_micros: 12_340_000, wallet_migrated_at: null });
    await ensureMigrated(env, "u1", NOW);
    expect(calls).toEqual([
      {
        path: "/v1/internal/credits/grant",
        body: { user_id: "u1", amount_micros: 12_340_000, kind: "gpushed_migration", ref: "gpushed-migration:u1" },
        secret: "svc",
      },
    ]);
    expect(runs.some((r) => /SET wallet_migrated_at = \?1/.test(r.sql))).toBe(true);
  });

  it("does nothing for an account already moved", async () => {
    const calls = stubSmartloop();
    const { env } = fakeEnv({ balance_micros: 12_340_000, wallet_migrated_at: NOW - 5 });
    await ensureMigrated(env, "u1", NOW);
    expect(calls).toEqual([]);
  });

  it("doesn't carry a negative balance over, but still marks the account", async () => {
    const calls = stubSmartloop();
    const { env, runs } = fakeEnv({ balance_micros: -50_000, wallet_migrated_at: null });
    await ensureMigrated(env, "u1", NOW);
    expect(calls).toEqual([]);
    expect(runs.some((r) => /SET wallet_migrated_at = \?1/.test(r.sql))).toBe(true);
  });
});

describe("syncBalance", () => {
  it("stores the balance and re-arms the low-balance email above the line", async () => {
    const { env, runs } = fakeEnv({ balance_micros: 0, wallet_migrated_at: 1 });
    await syncBalance(env, "u1", 7_000_000);
    expect(runs[0].args).toEqual([7_000_000, 2_000_000, "u1", 0]);
    expect(runs[0].sql).toMatch(/low_balance_warned = CASE WHEN \?1 > \?2 THEN 0/);
    expect(runs[0].sql).toMatch(/exhausted_at = CASE WHEN \?1 > 0 OR \?4 = 1 THEN NULL/);
  });

  it("marks a partner unlimited, which clears any out-of-money mark", async () => {
    const { env, runs } = fakeEnv({ balance_micros: 0, wallet_migrated_at: 1 });
    await syncBalance(env, "u1", 0, true);
    expect(runs[0].args).toEqual([0, 2_000_000, "u1", 1]);
    expect(runs[0].sql).toMatch(/unlimited = \?4/);
  });
});
