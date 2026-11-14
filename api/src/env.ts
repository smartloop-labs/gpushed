export interface Env {
  DB: D1Database;

  PUBLIC_URL: string; // e.g. https://api.smartloop.ai/v1/gpushed
  SMARTLOOP_API: string; // smartloop API that signs users in, e.g. https://api.smartloop.ai
  APP_ORIGINS?: string; // comma-separated web app origins allowed to call the API (CORS)
  REGIONS?: string; // comma-separated GCP regions boxes may run in (default: all in regions.ts)
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
