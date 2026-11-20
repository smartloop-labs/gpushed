import { afterEach, describe, expect, it, vi } from "vitest";
import { type Box, dispatchOrRevert, retryStuckProvisions, STUCK_AFTER_SEC, unreportedReclaims } from "../src/billing";
import { maybeReconcile } from "../src/external";
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

describe("unreportedReclaims", () => {
  const LISTED = NOW;
  const old = { status: "running" as const, updated_at: LISTED - 3600 };

  it("finds running Spot boxes whose VM GCP has stopped", () => {
    const boxes = [
      box({ id: "s1", plan: "l4-spot", ...old }), // reclaimed, unreported
      box({ id: "s2", plan: "l4-spot", ...old }), // still running
      box({ id: "o1", plan: "l4", ...old }), // on-demand: never reclaimed
      box({ id: "s3", plan: "a100-spot", ...old }), // no VM listed: left alone
    ];
    const vms = [
      { box_id: "s1", status: "TERMINATED" },
      { box_id: "s2", status: "RUNNING" },
      { box_id: "o1", status: "TERMINATED" },
    ];
    expect(unreportedReclaims(boxes, vms, LISTED).map((b) => b.id)).toEqual(["s1"]);
  });

  it("leaves a box that changed around the listing alone", () => {
    const started = box({ id: "s1", plan: "l4-spot", status: "running", updated_at: LISTED - 30 });
    expect(unreportedReclaims([started], [{ box_id: "s1", status: "TERMINATED" }], LISTED)).toEqual([]);
  });
});

describe("maybeReconcile", () => {
  function env(due: boolean, provisioner = "cloudrun") {
    const runs: string[] = [];
    const e = {
      PROVISIONER: provisioner,
      DEV: "1", // no GCP key: the run is only logged
      DB: {
        prepare(sql: string) {
          const stmt = {
            bind: () => stmt,
            first: async () => (runs.push(sql), sql.startsWith("INSERT") ? { id: 1 } : due ? { 1: 1 } : null),
          };
          return stmt;
        },
      },
    } as unknown as Env;
    return { e, runs };
  }

  it("queues a reconcile run when a Spot box runs and none ran lately", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { e, runs } = env(true);
    await maybeReconcile(e, ["l4-spot"], NOW);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatch(/^INSERT INTO provision_jobs/);
  });

  it("does nothing when not due, or on GitHub Actions", async () => {
    const a = env(false);
    await maybeReconcile(a.e, ["l4-spot"], NOW);
    expect(a.runs.filter((s) => s.startsWith("INSERT"))).toEqual([]);
    const b = env(true, "github");
    await maybeReconcile(b.e, ["l4-spot"], NOW);
    expect(b.runs).toEqual([]);
  });
});
