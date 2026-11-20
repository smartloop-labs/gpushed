import type { Env } from "./env";
import { nowSec } from "./util";

export type ProvisionAction = "up" | "down" | "stop" | "start";

// Ask the provisioner to run `action` on a box. Only the box ID is passed;
// the provisioner fetches the box's spec from /internal/boxes/:id.
//
// PROVISIONER picks where it runs:
//   cloudrun  queue the job in D1 and start an execution of the Cloud Run job
//             (CLOUD_RUN_JOB), which claims it from /internal/jobs/claim
//   github    (default) dispatch .github/workflows/provision.yml
export async function dispatchProvision(env: Env, action: ProvisionAction, boxId: string): Promise<void> {
  if (env.PROVISIONER === "cloudrun") return dispatchCloudRun(env, action, boxId);
  return dispatchGitHub(env, action, boxId);
}

// The execution is started with no overrides, so the Worker's service
// account needs only run.invoker on the job: a leaked key can start
// executions, which find nothing to claim, and nothing else. The job to do
// is in D1, where only this API puts it.
async function dispatchCloudRun(env: Env, action: ProvisionAction, boxId: string): Promise<void> {
  const queued = await env.DB.prepare(
    "INSERT INTO provision_jobs (box_id, action, created_at) VALUES (?1, ?2, ?3) RETURNING id",
  )
    .bind(boxId, action, nowSec())
    .first<{ id: number }>();
  try {
    if (!env.GCP_DISPATCH_KEY) {
      if (env.DEV === "1") {
        console.log(`[dev] would run ${env.CLOUD_RUN_JOB} for job ${queued?.id}: ${action} ${boxId}`);
        return;
      }
      throw new Error("GCP_DISPATCH_KEY is not set");
    }
    if (!env.CLOUD_RUN_JOB) throw new Error("CLOUD_RUN_JOB is not set");
    const token = await googleAccessToken(env.GCP_DISPATCH_KEY);
    const r = await fetch(`https://run.googleapis.com/v2/${env.CLOUD_RUN_JOB}:run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (!r.ok) throw new Error(`Cloud Run job run failed: ${r.status} ${await r.text()}`);
  } catch (e) {
    // Nobody will run it: don't leave it for an unrelated execution to pick
    // up later (the caller marks the box failed or retries).
    if (queued) await env.DB.prepare("DELETE FROM provision_jobs WHERE id = ?1").bind(queued.id).run();
    throw e;
  }
}

async function dispatchGitHub(env: Env, action: ProvisionAction, boxId: string): Promise<void> {
  if (!env.GITHUB_TOKEN) {
    if (env.DEV === "1") {
      console.log(`[dev] would dispatch ${env.GITHUB_WORKFLOW} action=${action} box_id=${boxId}`);
      return;
    }
    throw new Error("GITHUB_TOKEN is not set");
  }
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "gpushed-api",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF, inputs: { action, box_id: boxId } }),
  });
  if (!r.ok) throw new Error(`GitHub dispatch failed: ${r.status} ${await r.text()}`);
}

// ---------------------------------------------------------------- Google OAuth (service account key)

let cachedToken: { key: string; token: string; exp: number } | null = null;

// An access token for the service account whose JSON key is `keyJson`: a
// signed JWT traded at Google's token endpoint (RFC 7523). Kept for the life
// of the isolate until a minute before it expires.
export async function googleAccessToken(keyJson: string): Promise<string> {
  const now = nowSec();
  if (cachedToken && cachedToken.key === keyJson && cachedToken.exp - 60 > now) return cachedToken.token;
  const key = JSON.parse(keyJson) as { client_email: string; private_key: string; token_uri?: string };
  const aud = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const assertion = await signJwt(key.private_key, {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud,
    iat: now,
    exp: now + 3600,
  });
  const r = await fetch(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!r.ok) throw new Error(`Google token exchange failed: ${r.status} ${await r.text()}`);
  const t = (await r.json()) as { access_token: string; expires_in: number };
  cachedToken = { key: keyJson, token: t.access_token, exp: now + t.expires_in };
  return t.access_token;
}

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function signJwt(pem: string, claims: Record<string, unknown>): Promise<string> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const input =
    b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." + b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(input)));
  return `${input}.${b64url(sig)}`;
}

export function resetGoogleTokenCache(): void {
  cachedToken = null;
}

export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    if (env.DEV === "1") {
      console.log(`[dev] email to=${to} subject=${subject}\n${text}`);
      return;
    }
    throw new Error("RESEND_API_KEY is not set");
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
  });
  if (!r.ok) throw new Error(`email send failed: ${r.status} ${await r.text()}`);
}
