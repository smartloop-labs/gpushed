export interface Env {
  DB: D1Database;

  PUBLIC_URL: string; // e.g. https://api.gpushed.smartloop.ai
  REGION: string; // GCP region boxes are created in
  PREMIUM_PCT: string; // markup on GCP cost, e.g. "20"
  MIN_TOPUP_USD: string; // e.g. "10"
  LOW_BALANCE_USD: string; // warn at or below this balance
  STOPPED_GRACE_HOURS: string; // destroy a box stopped for lack of funds after this long
  GITHUB_REPO: string; // owner/name holding the provision workflow
  GITHUB_WORKFLOW: string; // e.g. provision.yml
  GITHUB_REF: string; // branch the workflow runs from
  EMAIL_FROM: string;
  DEV?: string; // "1": log emails and dispatches instead of sending them

  // Secrets (wrangler secret put ...)
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  GITHUB_TOKEN?: string; // fine-grained token: Actions read/write on GITHUB_REPO
  PROVISIONER_SECRET?: string; // shared with the provision workflow
}

export function numVar(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
