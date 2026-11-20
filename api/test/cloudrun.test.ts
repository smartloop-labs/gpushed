import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { dispatchProvision, resetGoogleTokenCache } from "../src/external";

const JOB = "projects/p/locations/us-central1/jobs/gpushed-provisioner";
let keyJson = "";
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  keyJson = JSON.stringify({
    client_email: "gpushed-dispatcher@p.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    token_uri: "https://oauth2.googleapis.com/token",
  });
});

// A D1 stand-in for the provision_jobs statements.
function fakeEnv(over: Partial<Env> = {}) {
  const runs: { sql: string; args: unknown[] }[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind: (...a: unknown[]) => ((args = a), stmt),
          run: async () => (runs.push({ sql, args }), {}),
          first: async () => (runs.push({ sql, args }), { id: 7 }),
        };
        return stmt;
      },
    },
    PROVISIONER: "cloudrun",
    CLOUD_RUN_JOB: JOB,
    GCP_DISPATCH_KEY: keyJson,
    ...over,
  } as unknown as Env;
  return { env, runs };
}

const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

function stubGoogle(runStatus: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    }
    return new Response("{}", { status: runStatus });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetGoogleTokenCache();
});

describe("dispatchProvision on Cloud Run", () => {
  it("queues the job and runs the Cloud Run job without overrides", async () => {
    const calls = stubGoogle(200);
    const { env, runs } = fakeEnv();
    await dispatchProvision(env, "up", "babcdefghijk");

    expect(runs).toHaveLength(1);
    expect(runs[0].sql).toMatch(/^INSERT INTO provision_jobs/);
    expect(runs[0].args.slice(0, 2)).toEqual(["babcdefghijk", "up"]);

    // A signed JWT for the dispatcher account, traded for a token...
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, sig] = form.get("assertion")!.split(".");
    const claims = JSON.parse(new TextDecoder().decode(unb64url(c)));
    expect(claims.iss).toBe("gpushed-dispatcher@p.iam.gserviceaccount.com");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      unb64url(sig),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);

    // ...then the job run, with nothing about the box in it.
    expect(calls[1].url).toBe(`https://run.googleapis.com/v2/${JOB}:run`);
    expect(new Headers(calls[1].init.headers).get("authorization")).toBe("Bearer ya29.test");
    expect(calls[1].init.body).toBe("{}");
  });

  it("reuses the access token", async () => {
    const calls = stubGoogle(200);
    const { env } = fakeEnv();
    await dispatchProvision(env, "stop", "babcdefghijk");
    await dispatchProvision(env, "start", "babcdefghijk");
    expect(calls.map((c) => c.url).filter((u) => u.includes("oauth2"))).toHaveLength(1);
  });

  it("drops the queued job and throws when the job can't be run", async () => {
    stubGoogle(403);
    const { env, runs } = fakeEnv();
    await expect(dispatchProvision(env, "down", "babcdefghijk")).rejects.toThrow(/Cloud Run job run failed: 403/);
    expect(runs.map((r) => r.sql)).toEqual([expect.stringMatching(/^INSERT/), "DELETE FROM provision_jobs WHERE id = ?1"]);
    expect(runs[1].args).toEqual([7]);
  });

  it("only logs in dev without a key", async () => {
    const calls = stubGoogle(200);
    const { env, runs } = fakeEnv({ GCP_DISPATCH_KEY: undefined, DEV: "1" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await dispatchProvision(env, "up", "babcdefghijk");
    expect(calls).toEqual([]);
    expect(runs).toHaveLength(1); // still queued, as in production
  });
});
