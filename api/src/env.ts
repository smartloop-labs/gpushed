export interface Env {
  DB: D1Database;

  PUBLIC_URL: string; // e.g. https://api.gpushed.dev
  SMARTLOOP_API: string; // smartloop API that signs users in, e.g. https://api.smartloop.ai
  APP_ORIGINS?: string; // comma-separated web app origins allowed to call the API (CORS)
  REGIONS?: string; // comma-separated GCP regions boxes may run in (default: all in regions.ts)
  PREMIUM_PCT: string; // markup on GCP cost, e.g. "20"
  MIN_TOPUP_USD: string; // e.g. "10"
  LOW_BALANCE_USD: string; // warn at or below this balance
  STOPPED_MAX_HOURS?: string; // destroy any box stopped this long, funded or not, and an unfunded failed one (default 24)
  IDLE_STOP_MINUTES?: string; // a box with an idle GPU stops itself after this many minutes (0: never)
  PROVISIONER?: string; // "cloudrun": run the Cloud Run job; otherwise ("github") the provision workflow
  CLOUD_RUN_JOB?: string; // projects/<p>/locations/<region>/jobs/gpushed-provisioner
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
  GCP_DISPATCH_KEY?: string; // JSON key of gpushed-dispatcher: run.invoker on CLOUD_RUN_JOB only
  PROVISIONER_SECRET?: string; // shared with the provisioner
  SMARTLOOP_SERVICE_SECRET?: string; // smartloop API's GPUSHED_SERVICE_SECRET: spends and tops up credits
}

export function numVar(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
