import { afterEach, describe, expect, it, vi } from "vitest";
import { type Box, dispatchOrRevert, retryStuckProvisions, STUCK_AFTER_SEC } from "../src/billing";
import type { Env } from "../src/env";

const NOW = 1_800_000_000;

function box(over: Partial<Box> = {}): Box {
  return {
    id: "b1",
    user_id: "u1",
    plan: "l4",
    status: "stopping",
    region: "us-central1",
    regions: "us-central1",
    zone: "us-central1-b",
    ip: null,
    ssh_public_key: "ssh-ed25519 AAAA",
    hourly_micros: 1_000_000,
    stopped_hourly_micros: 28_000,
    metered_until: NOW, // already metered this run: no usage queries
    stopped_at: null,
    error: null,
    progress: null,
    created_at: NOW - 86_400,
    updated_at: NOW - STUCK_AFTER_SEC - 1,
    ...over,
  };
}

// A D1 stand-in that records every statement run and answers SELECTs with `rows`.
function fakeEnv(rows: Box[] = []) {
  const runs: { sql: string; args: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind: (...a: unknown[]) => ((args = a), stmt),
          run: async () => (runs.push({ sql, args }), {}),
          all: async () => (runs.push({ sql, args }), { results: rows }),
        };
        return stmt;
      },
    },
    GITHUB_TOKEN: "ghp_test",
    GITHUB_REPO: "o/r",
    GITHUB_WORKFLOW: "provision.yml",
    GITHUB_REF: "main",
  } as unknown as Env;
  return { env, runs };
}

function stubGitHub(status: number) {
  const dispatched: { action: string; box_id: string }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    dispatched.push(JSON.parse(String(init.body)).inputs);
    return new Response(null, { status });
  });
  return dispatched;
}

afterEach(() => vi.unstubAllGlobals());

describe("dispatchOrRevert", () => {
  it("leaves the box alone when the dispatch succeeds", async () => {
    const dispatched = stubGitHub(204);
    const { env, runs } = fakeEnv();
    expect(await dispatchOrRevert(env, box(), "stop", "running", NOW)).toBe(true);
    expect(dispatched).toEqual([{ action: "stop", box_id: "b1" }]);
    expect(runs).toEqual([]);
  });

  it("puts the box back so the next cron run retries when GitHub is unreachable", async () => {
    stubGitHub(503);
    const { env, runs } = fakeEnv();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchOrRevert(env, box(), "stop", "running", NOW)).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toMatch(/^UPDATE boxes SET status = \?2/);
    expect(runs[0].args).toEqual(["b1", "running", NOW]);
  });
});

describe("retryStuckProvisions", () => {
  it("only looks at boxes stuck longer than the provision timeout", async () => {
    stubGitHub(204);
    const { env, runs } = fakeEnv([]);
    await retryStuckProvisions(env, NOW);
    expect(runs[0].sql).toContain("status IN ('stopping', 'destroying')");
    expect(runs[0].args).toEqual([NOW - STUCK_AFTER_SEC]);
  });

  it("dispatches stop again for a stuck stopping box and down for a stuck destroying one", async () => {
    const dispatched = stubGitHub(204);
    const { env, runs } = fakeEnv([box({ id: "s" }), box({ id: "d", status: "destroying" })]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await retryStuckProvisions(env, NOW);
    expect(dispatched).toEqual([
      { action: "stop", box_id: "s" },
      { action: "down", box_id: "d" },
    ]);
    // updated_at is touched first, so each box is retried at most every STUCK_AFTER_SEC.
    const touches = runs.filter((r) => r.sql.startsWith("UPDATE boxes SET updated_at"));
    expect(touches.map((r) => r.args)).toEqual([
      ["s", NOW],
      ["d", NOW],
    ]);
  });

  it("keeps going when one dispatch fails", async () => {
    const dispatched: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { box_id } = JSON.parse(String(init.body)).inputs;
      dispatched.push(box_id);
      return new Response(null, { status: box_id === "a" ? 500 : 204 });
    });
    const { env } = fakeEnv([box({ id: "a" }), box({ id: "b" })]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await retryStuckProvisions(env, NOW);
    expect(dispatched).toEqual(["a", "b"]);
  });
});
