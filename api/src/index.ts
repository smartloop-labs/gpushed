import { type Box, type User, dispatchOrRevert, getBox, meterBox, recordTopup, refreshBalance, runMetering, updateBox, welcomeOnFirstTopup } from "./billing";
import { type Env, numVar } from "./env";
import { type ProvisionAction, dispatchProvision, sendEmail } from "./external";
import { DEFAULT_PLAN, PLANS, planPrice } from "./pricing";
import { REGIONS, byAvailability, byDistance, enabledRegions, offeredRegions, regionOfZone, requestLocation } from "./regions";
import { PLAN_ZONES } from "./zones.generated";
import { grantCredits, topupCheckoutUrl } from "./smartloop";
import { type CheckoutSession, topupCents, verifyStripeSignature } from "./stripe";
import { HttpError, boxId, hmacSha256Hex, isZone, json, normalizeUserCode, nowSec, randomToken, readJson, sha256Hex, timingSafeEqual, usd, userCode } from "./util";

const SSH_USER = "boxuser";
// How long a zone that ran out of a machine type is tried last for new boxes.
const STOCKOUT_SECS = 20 * 60;
const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,3}$/;
// Statuses of a box whose VM may exist; a user has at most one such box.
const ACTIVE = "status != 'destroyed'";

type Handler = (req: Request, env: Env, params: Record<string, string>) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), h]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const res = await handle(req, env);
    const origin = req.headers.get("origin");
    if (origin && allowedOrigin(env, origin)) {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMetering(env, nowSec()));
  },
};

// Served at https://api.gpushed.dev (see wrangler.toml).
async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    for (const [method, re, h] of routes) {
      const m = path.match(re);
      if (m && req.method === method) return await h(req, env, m.groups ?? {});
    }
    throw new HttpError(404, "not found");
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "internal error" }, 500);
  }
}

// The smartloop web app (APP_ORIGINS) calls the API from the browser.
function allowedOrigin(env: Env, origin: string): boolean {
  return (env.APP_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean).includes(origin);
}

// The web app's Billing page (on the first of APP_ORIGINS), where credits
// are added and shown; null when no app origin is configured.
export function billingUrl(env: Pick<Env, "APP_ORIGINS">): URL | null {
  const origin = (env.APP_ORIGINS ?? "").split(",").map((o) => o.trim()).find(Boolean);
  if (!origin) return null;
  try {
    return new URL("/settings/billing", origin);
  } catch {
    return null;
  }
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

// ---------------------------------------------------------------- helpers

// The CLI sends its gpushed API token (gp_...); the smartloop web app sends
// the user's smartloop access token, which smartloop itself verifies.
async function authUser(req: Request, env: Env): Promise<User> {
  const bearer = (req.headers.get("authorization") ?? "").match(/^Bearer (\S+)$/)?.[1];
  if (!bearer) throw new HttpError(401, "not signed in; run: gpushed login");
  if (!bearer.startsWith("gp_")) return smartloopUser(env, bearer);
  const user = await env.DB.prepare(
    "SELECT u.* FROM users u JOIN api_tokens t ON t.user_id = u.id WHERE t.token_hash = ?1",
  )
    .bind(await sha256Hex(bearer))
    .first<User>();
  if (!user) throw new HttpError(401, "session expired or revoked; run: gpushed login");
  return user;
}

// Look up the smartloop account a smartloop access token belongs to, and the
// matching gpushed user (created on first use; its id is the smartloop user id).
async function smartloopUser(env: Env, accessToken: string): Promise<User> {
  if (!/^[A-Za-z0-9._~+/=-]{16,4096}$/.test(accessToken)) throw new HttpError(401, "not signed in; run: gpushed login");
  let res: Response;
  try {
    res = await fetch(`${env.SMARTLOOP_API}/v1/users/me`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
  } catch (e) {
    console.error(e);
    throw new HttpError(502, "could not reach smartloop sign-in; try again shortly");
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(401, "smartloop session expired; run: gpushed login");
  }
  if (!res.ok) throw new HttpError(502, `smartloop sign-in failed (HTTP ${res.status})`);
  const me = await res.json<{ id?: string; email?: string; is_active?: boolean }>();
  if (!me.id || !me.email) throw new HttpError(502, "unexpected response from smartloop");
  if (me.is_active === false) throw new HttpError(403, "your smartloop account is not active");
  await env.DB.prepare(
    "INSERT INTO users (id, email, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET email = excluded.email",
  )
    .bind(me.id, me.email.toLowerCase(), nowSec())
    .run();
  return (await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(me.id).first<User>())!;
}

function requireProvisioner(req: Request, env: Env): void {
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!env.PROVISIONER_SECRET || !timingSafeEqual(got, env.PROVISIONER_SECRET)) {
    throw new HttpError(401, "unauthorized");
  }
}

async function activeBox(env: Env, userId: string): Promise<Box | null> {
  return env.DB.prepare(`SELECT * FROM boxes WHERE user_id = ?1 AND ${ACTIVE} ORDER BY created_at DESC LIMIT 1`)
    .bind(userId)
    .first<Box>();
}

// GPUs of the plan our boxes hold, per region: those being created, started,
// running or stopping. A stopped VM holds no GPU quota. (One GPU per box.)
async function gpusInUse(env: Env, planId: string): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare(
    `SELECT region, COUNT(*) AS n FROM boxes
       WHERE plan = ?1 AND status IN ('pending', 'starting', 'running', 'stopping')
       GROUP BY region`,
  )
    .bind(planId)
    .all<{ region: string; n: number }>();
  return Object.fromEntries(results.map((r) => [r.region, Number(r.n)]));
}

function boxView(box: Box) {
  return {
    id: box.id,
    plan: box.plan,
    spot: !!PLANS[box.plan]?.spot, // Google may reclaim (stop) it at any time
    status: box.status,
    region: box.region,
    region_name: REGIONS.find((r) => r.id === box.region)?.name ?? box.region,
    zone: box.zone,
    ip: box.ip,
    ssh_user: SSH_USER,
    hourly_usd: usd(box.hourly_micros),
    stopped_hourly_usd: usd(box.stopped_hourly_micros),
    error: box.error,
    progress: box.progress ?? null,
    created_at: box.created_at,
  };
}

// The user with credits read fresh from smartloop (plan credits left plus the
// wallet), which also stores them. If smartloop can't be reached, the last
// stored figure is used, so a hiccup there doesn't take gpushed down.
async function withCredits(env: Env, user: User): Promise<User> {
  try {
    const credits = await refreshBalance(env, user.id, nowSec());
    return { ...user, balance_micros: credits.available_micros, plan: credits.plan, unlimited: credits.unlimited ? 1 : 0 };
  } catch (e) {
    console.error(`reading credits for ${user.id} failed; using the stored balance`, e);
    return user;
  }
}

// Plan names as smartloop billing shows them.
const PLAN_LABELS: Record<string, string> = { free: "Free", paid: "Pro", plus: "Plus", max: "Max", partner: "Partner" };

function account(env: Env, user: User) {
  return {
    email: user.email,
    plan: user.plan ?? null,
    plan_label: user.plan ? (PLAN_LABELS[user.plan] ?? user.plan) : null,
    // GPU time is free and boxes never stop for credit (a smartloop Partner).
    unlimited: !!user.unlimited,
    balance_usd: usd(user.balance_micros),
    balance_micros: user.balance_micros,
    low_balance: !user.unlimited && user.balance_micros > 0 && user.balance_micros <= numVar(env.LOW_BALANCE_USD, 2) * 1e6,
    min_topup_usd: numVar(env.MIN_TOPUP_USD, 10),
  };
}

async function dispatchOrFail(env: Env, box: Box, action: ProvisionAction, now: number): Promise<void> {
  try {
    await dispatchProvision(env, action, box.id);
  } catch (e) {
    console.error(e);
    await updateBox(env, box, { status: "failed", error: `could not start ${action}: provisioner unavailable` }, now);
    throw new HttpError(502, "could not reach the provisioner; try again shortly");
  }
}

// A small page the browser lands on (Stripe's return from a CLI top-up, ...).
// Needs no sign-in. `body` is trusted HTML written here, never user input.
function html(title: string, body: string, mark = ""): Response {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title} · gpushed</title>` +
      `<style>
        :root{--bg:#f7f8f5;--fg:#141613;--muted:#5d6459;--card:#fff;--line:#e3e7df;--accent:#3f8f1f;--accent-ink:#fff;--code:#eef2ea}
        @media (prefers-color-scheme:dark){:root{--bg:#0d0f0c;--fg:#eef1eb;--muted:#9aa394;--card:#151813;--line:#262b23;--accent:#84e05a;--accent-ink:#0d0f0c;--code:#1c2119}}
        *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,sans-serif}
        main{max-width:30rem;margin:12vh auto;padding:0 1rem}
        .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:2rem}
        .brand{display:inline-block;font-weight:700;letter-spacing:-.01em;margin-bottom:1.5rem;color:var(--fg);text-decoration:none}.brand b{color:var(--accent)}
        h1{font-size:1.5rem;margin:0 0 .75rem;display:flex;gap:.6rem;align-items:center}
        .mark{color:var(--accent)}p{color:var(--muted);margin:.6rem 0}
        code{background:var(--code);color:var(--fg);padding:.1rem .4rem;border-radius:6px;font-size:.92em}
        .next{margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--line)}
        a.btn{display:inline-block;margin-top:.5rem;padding:.55rem 1rem;border-radius:9px;border:1px solid var(--accent);color:var(--accent);text-decoration:none;font-weight:600}
        a.btn:hover{background:var(--accent);color:var(--accent-ink)}
      </style>` +
      `<main><div class="card"><a class="brand" href="https://gpushed.dev">gpu<b>shed</b></a>` +
      `<h1>${mark ? `<span class="mark">${mark}</span>` : ""}${title}</h1>${body}</div></main></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

// ---------------------------------------------------------------- sign-in

// gpushed accounts are smartloop accounts. The CLI signs in to smartloop
// (emailed code, at SMARTLOOP_API) and trades the smartloop access token for a
// long-lived gpushed API token here, so it never has to refresh smartloop
// tokens. The smartloop web app can also call these routes with its own
// session token (see authUser).
route("POST", "/auth/smartloop", async (req, env) => {
  const { access_token } = await readJson<{ access_token?: string }>(req);
  const user = await withCredits(env, await smartloopUser(env, String(access_token ?? "")));
  const token = "gp_" + randomToken();
  await env.DB.prepare("INSERT INTO api_tokens (token_hash, user_id, created_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256Hex(token), user.id, nowSec())
    .run();
  return json({ status: "ok", token, account: account(env, user) });
});

// Browser sign-in for the CLI. The CLI starts a sign-in and opens the web app at
// /gpushed/cli-login?code=<user_code>; the signed-in user approves it there, and
// the CLI, polling with its secret device code, then gets an API token. Only the
// device code's hash is stored, and a sign-in lasts CLI_LOGIN_TTL seconds.
const CLI_LOGIN_TTL = 600;

route("POST", "/auth/cli/start", async (_req, env) => {
  const now = nowSec();
  await env.DB.prepare("DELETE FROM cli_logins WHERE expires_at < ?1").bind(now).run();
  const deviceCode = randomToken();
  const code = userCode();
  await env.DB.prepare("INSERT INTO cli_logins (device_hash, user_code, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(await sha256Hex(deviceCode), code, now, now + CLI_LOGIN_TTL)
    .run();
  const app = (env.APP_ORIGINS ?? "").split(",")[0].trim() || "https://app.smartloop.ai";
  return json({
    device_code: deviceCode,
    user_code: code,
    url: `${app}/gpushed/cli-login?code=${code}`,
    expires_in: CLI_LOGIN_TTL,
    interval: 3,
  });
});

// Called by the web app with the user's smartloop session (not a gpushed token,
// so a leaked CLI token can't approve more sign-ins).
route("POST", "/auth/cli/approve", async (req, env) => {
  const bearer = (req.headers.get("authorization") ?? "").match(/^Bearer (\S+)$/)?.[1] ?? "";
  if (!bearer || bearer.startsWith("gp_")) throw new HttpError(401, "sign in on the smartloop web app");
  const user = await smartloopUser(env, bearer);
  const { user_code } = await readJson<{ user_code?: string }>(req);
  const code = normalizeUserCode(String(user_code ?? ""));
  if (!code) throw new HttpError(400, "that doesn't look like a sign-in code");
  const r = await env.DB.prepare(
    "UPDATE cli_logins SET user_id = ?1 WHERE user_code = ?2 AND user_id IS NULL AND expires_at >= ?3",
  )
    .bind(user.id, code, nowSec())
    .run();
  if (!r.meta.changes) throw new HttpError(404, "this sign-in code has expired or was already used; run gpushed login again");
  return json({ status: "ok", email: user.email });
});

route("POST", "/auth/cli/poll", async (req, env) => {
  const { device_code } = await readJson<{ device_code?: string }>(req);
  const hash = await sha256Hex(String(device_code ?? ""));
  const row = await env.DB.prepare("SELECT user_id, expires_at FROM cli_logins WHERE device_hash = ?1")
    .bind(hash)
    .first<{ user_id: string | null; expires_at: number }>();
  if (!row || row.expires_at < nowSec()) throw new HttpError(410, "the sign-in expired; run gpushed login again");
  if (!row.user_id) return json({ status: "pending" }, 202);
  // One token per approval: delete first, so a second poll can't get another.
  const del = await env.DB.prepare("DELETE FROM cli_logins WHERE device_hash = ?1 AND user_id IS NOT NULL").bind(hash).run();
  if (!del.meta.changes) throw new HttpError(410, "the sign-in expired; run gpushed login again");
  const stored = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(row.user_id).first<User>();
  if (!stored) throw new HttpError(410, "the sign-in expired; run gpushed login again");
  const user = await withCredits(env, stored);
  const token = "gp_" + randomToken();
  await env.DB.prepare("INSERT INTO api_tokens (token_hash, user_id, created_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256Hex(token), user.id, nowSec())
    .run();
  return json({ status: "ok", token, account: account(env, user) });
});

route("POST", "/auth/logout", async (req, env) => {
  await authUser(req, env);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  await env.DB.prepare("DELETE FROM api_tokens WHERE token_hash = ?1").bind(await sha256Hex(token)).run();
  return json({ status: "ok" });
});

// ---------------------------------------------------------------- account and billing

// Plans priced for one region: ?region=, or the region nearest the caller
// (where `gpushed up` would try first).
route("GET", "/plans", async (req, env) => {
  const premium = numVar(env.PREMIUM_PCT, 20);
  const regions = enabledRegions(env.REGIONS);
  const asked = new URL(req.url).searchParams.get("region");
  const loc = requestLocation(req);
  const region = asked ? regions.find((r) => r.id === asked) : byDistance(regions, loc.lat, loc.lon)[0];
  if (!region) throw new HttpError(400, `unknown region; choose one of: ${regions.map((r) => r.id).join(", ")}`);
  return json({
    default: DEFAULT_PLAN,
    region: region.id,
    region_name: region.name,
    nearest: !asked,
    regions: regions.map((r) => ({ id: r.id, name: r.name })),
    plans: Object.values(PLANS).flatMap((p) => {
      const price = planPrice(p, region.id, premium);
      if (!price) return [];
      // Enabled regions with a price, a zone offering the machine, and GPU quota.
      const where = offeredRegions(env.REGIONS, p.id);
      const offered = where.some((r) => r.id === region.id);
      return [
        {
          id: p.id,
          label: p.label,
          machine_type: p.machineType,
          // A Spot VM: Google may reclaim (stop) it at any time.
          spot: !!p.spot,
          hourly_usd: usd(price.hourlyMicros),
          stopped_hourly_usd: usd(price.stoppedHourlyMicros),
          // available: can be created now; unavailable: not offered yet (no GCP
          // quota); elsewhere: offered, but not in this region.
          status: !p.available || where.length === 0 ? "unavailable" : offered ? "available" : "elsewhere",
          regions: p.available ? where.map((r) => r.id) : [],
        },
      ];
    }),
  });
});

route("GET", "/me", async (req, env) => {
  const user = await withCredits(env, await authUser(req, env));
  const box = await activeBox(env, user.id);
  return json({ ...account(env, user), box: box ? boxView(box) : null });
});

// Recent ledger rows, newest first. ?kind=topup (or usage, adjust) filters;
// usage is charged every few minutes, so /usage is better for totals.
route("GET", "/ledger", async (req, env) => {
  const user = await authUser(req, env);
  const kind = new URL(req.url).searchParams.get("kind");
  if (kind && !["topup", "usage", "adjust"].includes(kind)) throw new HttpError(400, "kind must be topup, usage or adjust");
  const { results } = await env.DB.prepare(
    "SELECT amount_micros, kind, ref, created_at FROM ledger WHERE user_id = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY id DESC LIMIT 50",
  )
    .bind(user.id, kind)
    .all<{ amount_micros: number; kind: string; ref: string; created_at: number }>();
  return json({
    entries: results.map((e) => ({ amount_usd: usd(e.amount_micros), kind: e.kind, created_at: e.created_at })),
  });
});

// Spending and top-ups per day (UTC) for the last ?days= days (default 30).
route("GET", "/usage", async (req, env) => {
  const user = await authUser(req, env);
  const days = Math.min(Math.max(Math.floor(Number(new URL(req.url).searchParams.get("days") ?? 30)) || 30, 1), 365);
  const since = nowSec() - days * 86400;
  const { results } = await env.DB.prepare(
    `SELECT date(created_at, 'unixepoch') AS day,
            SUM(CASE WHEN kind = 'usage' THEN -amount_micros ELSE 0 END) AS usage_micros,
            SUM(CASE WHEN kind = 'topup' THEN amount_micros ELSE 0 END) AS topup_micros
       FROM ledger WHERE user_id = ?1 AND created_at >= ?2 GROUP BY day ORDER BY day`,
  )
    .bind(user.id, since)
    .all<{ day: string; usage_micros: number; topup_micros: number }>();
  const total = (k: "usage_micros" | "topup_micros") => results.reduce((n, r) => n + r[k], 0);
  return json({
    days,
    daily: results.map((r) => ({ date: r.day, usage_usd: usd(r.usage_micros), topup_usd: usd(r.topup_micros) })),
    total_usage_usd: usd(total("usage_micros")),
    total_topup_usd: usd(total("topup_micros")),
  });
});

route("POST", "/topup", async (req, env) => {
  const user = await authUser(req, env);
  const { amount_usd, return_url } = await readJson<{ amount_usd?: number; return_url?: string }>(req);
  const min = numVar(env.MIN_TOPUP_USD, 10);
  const amount = Number(amount_usd ?? min);
  if (!Number.isFinite(amount) || amount < min) throw new HttpError(400, `the minimum top-up is $${min}`);
  if (amount > 5000) throw new HttpError(400, "the maximum top-up is $5000");
  if (!env.SMARTLOOP_SERVICE_SECRET) throw new HttpError(503, "payments are not configured");
  // Where Stripe sends people back: to return_url when the web app asks (only
  // on APP_ORIGINS; they're signed in there), otherwise (the CLI) to gpushed's
  // own confirmation pages, which need no sign-in and link to Billing.
  let back: URL | null = null;
  if (return_url) {
    try {
      back = new URL(String(return_url));
    } catch {
      back = null;
    }
    if (!back || !allowedOrigin(env, back.origin)) throw new HttpError(400, "return_url must be on the smartloop web app");
  }
  const withStatus = (status: string) => {
    if (!back) return `${env.PUBLIC_URL}/topup/${status}`;
    const u = new URL(back.href);
    u.searchParams.set("topup", status);
    return u.href;
  };
  // Charged to the account's smartloop customer (one billing history for
  // plans and credits); smartloop adds the credits when Stripe confirms.
  const url = await topupCheckoutUrl(env, user.id, amount, withStatus("done"), withStatus("cancelled"));
  return json({ url });
});

// Where Stripe returns a top-up started from the CLI: gpushed's own pages,
// which need no sign-in (the app's Billing page would ask the browser to
// sign in to smartloop first).
route("GET", "/topup/done", async (_req, env) => {
  const billing = billingUrl(env);
  return html(
    "Payment received",
    `<p>Your credits are added to your smartloop account in a few seconds. You can close this tab and go back to your terminal.</p>` +
      (billing
        ? `<p>Your credits, plan and invoices are in Billing on the smartloop dashboard.</p><a class="btn" href="${billing.href}">Open Billing</a>`
        : "") +
      `<div class="next"><p>Next, in your terminal:</p><p><code>gpushed balance</code> to see your credits<br><code>gpushed up</code> to start a GPU box</p></div>`,
    "✓",
  );
});
route("GET", "/topup/cancelled", async () =>
  html(
    "Checkout cancelled",
    `<p>You weren't charged, and nothing changed on your account. You can close this tab.</p>` +
      `<div class="next"><p>To add credits, run <code>gpushed topup</code> again.</p></div>`,
  ),
);

route("POST", "/stripe/webhook", async (req, env) => {
  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET ?? "", nowSec());
  if (!ok) throw new HttpError(400, "bad signature");
  const event = JSON.parse(payload) as { type: string; data: { object: CheckoutSession } };
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object;
    if (s.metadata?.app !== "gpushed") return json({ received: true });
    const userId = s.metadata?.user_id ?? s.client_reference_id;
    const cents = topupCents(s);
    if (!userId || cents <= 0) return json({ received: true });
    const now = nowSec();
    if (s.metadata?.kind !== "topup") {
      // A checkout gpushed opened itself before credits moved to smartloop:
      // nobody else will credit it, so add it to the wallet here (once, by
      // its Stripe session). One already credited the old way is in the
      // balance that was moved over, and is skipped.
      const seen = await env.DB.prepare("SELECT 1 FROM ledger WHERE ref = ?1").bind(`stripe:${s.id}`).first();
      if (seen) return json({ received: true });
      await grantCredits(env, userId, cents * 10_000, "topup", `topup:stripe:${s.id}`);
    }
    // smartloop's own webhook adds the credits for a top-up it opened; here
    // it only goes into gpushed's history, which drives the welcome email.
    if (await recordTopup(env, userId, cents * 10_000, `stripe:${s.id}`, now)) {
      await refreshBalance(env, userId, now).catch((e) => console.error(`refreshing ${userId} failed`, e));
      await welcomeOnFirstTopup(env, userId);
    }
  }
  return json({ received: true });
});

// ---------------------------------------------------------------- boxes

function balanceShortMessage(balanceMicros: number, planId: string, hourlyMicros: number): string {
  return `balance $${usd(balanceMicros)} is less than one hour of ${planId} ($${usd(hourlyMicros)}); run gpushed topup`;
}

route("POST", "/box", async (req, env) => {
  const user = await authUser(req, env);
  const body = await readJson<{ plan?: string; ssh_public_key?: string; region?: string }>(req);
  const plan = PLANS[body.plan ?? DEFAULT_PLAN];
  if (!plan) throw new HttpError(400, `unknown plan; choose one of: ${Object.keys(PLANS).join(", ")}`);
  if (!plan.available) throw new HttpError(503, `${plan.id} isn't available yet; see gpushed plans`);
  // Drop the key's comment: it ends up in GCE metadata as "user:type key".
  const key = String(body.ssh_public_key ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
  if (!SSH_KEY_RE.test(key) || key.length > 4096) throw new HttpError(400, "invalid SSH public key");

  let existing = await activeBox(env, user.id);
  // A box whose creation failed (a stockout, say) never got a VM and costs
  // nothing: clear it out of the way rather than make the user run down.
  if (existing?.status === "failed" && existing.metered_until == null && !existing.zone) {
    await updateBox(env, existing, { status: "destroyed" }, nowSec());
    // Sweep up anything half-created; the provisioner usually already has.
    await dispatchProvision(env, "down", existing.id).catch((e) => console.error(`sweeping ${existing!.id} failed`, e));
    existing = null;
  }
  if (existing) throw new HttpError(409, `you already have a box (${existing.id}, ${existing.status}); run gpushed down first`);

  // Regions to try, in order: the one asked for, or those with GPUs to spare
  // first (nearest first), then the full ones. The box is billed at the price
  // of the region it lands in.
  const offered = offeredRegions(env.REGIONS, plan.id);
  const loc = requestLocation(req);
  let candidates = byAvailability(offered, plan.id, await gpusInUse(env, plan.id), loc.lat, loc.lon);
  if (body.region) {
    candidates = offered.filter((r) => r.id === body.region);
    if (candidates.length === 0) {
      throw new HttpError(400, `${plan.id} isn't offered in ${body.region}; choose one of: ${offered.map((r) => r.id).join(", ")}`);
    }
  }
  if (candidates.length === 0) throw new HttpError(503, `${plan.id} isn't available right now`);
  const premium = numVar(env.PREMIUM_PCT, 20);
  // At least an hour at the price shown for the first region (what plans shows).
  const price = planPrice(plan, candidates[0].id, premium)!;
  const { balance_micros: available, unlimited } = await withCredits(env, user);
  if (!unlimited && available < price.hourlyMicros) {
    throw new HttpError(402, balanceShortMessage(available, plan.id, price.hourlyMicros));
  }
  const now = nowSec();
  const box: Box = {
    id: boxId(),
    user_id: user.id,
    plan: plan.id,
    status: "pending",
    region: candidates[0].id,
    regions: candidates.map((r) => r.id).join(","),
    zone: null,
    ip: null,
    ssh_public_key: key,
    hourly_micros: price.hourlyMicros,
    stopped_hourly_micros: price.stoppedHourlyMicros,
    metered_until: null,
    stopped_at: null,
    error: null,
    progress: null,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO boxes (id, user_id, plan, status, region, regions, ssh_public_key, hourly_micros, stopped_hourly_micros, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
  )
    .bind(box.id, box.user_id, box.plan, box.status, box.region, box.regions, box.ssh_public_key, box.hourly_micros, box.stopped_hourly_micros, now)
    .run();
  await dispatchOrFail(env, box, "up", now);
  return json({ box: boxView(box) }, 201);
});

route("GET", "/box", async (req, env) => {
  const user = await authUser(req, env);
  const box = await activeBox(env, user.id);
  if (!box) throw new HttpError(404, "you have no box; create one with gpushed up");
  return json({ box: boxView(box), account: account(env, user) });
});

route("POST", "/box/stop", async (req, env) => {
  const user = await authUser(req, env);
  const box = await activeBox(env, user.id);
  if (!box) throw new HttpError(404, "you have no box");
  if (box.status !== "running") throw new HttpError(409, `box is ${box.status}; only a running box can be stopped`);
  const now = nowSec();
  const updated = await updateBox(env, box, { status: "stopping" }, now);
  await dispatchOrFail(env, updated, "stop", now);
  return json({ box: boxView(updated) });
});

route("POST", "/box/start", async (req, env) => {
  const user = await authUser(req, env);
  const box = await activeBox(env, user.id);
  if (!box) throw new HttpError(404, "you have no box");
  if (box.status !== "stopped") throw new HttpError(409, `box is ${box.status}; only a stopped box can be started`);
  const { balance_micros: available, unlimited } = await withCredits(env, user);
  if (!unlimited && available < box.hourly_micros) {
    throw new HttpError(402, balanceShortMessage(available, box.plan, box.hourly_micros));
  }
  const now = nowSec();
  const updated = await updateBox(env, box, { status: "starting" }, now);
  await dispatchOrFail(env, updated, "start", now);
  return json({ box: boxView(updated) });
});

route("DELETE", "/box", async (req, env) => {
  const user = await authUser(req, env);
  const box = await activeBox(env, user.id);
  if (!box) throw new HttpError(404, "you have no box");
  if (box.status === "destroying") return json({ box: boxView(box) });
  const now = nowSec();
  const updated = await updateBox(env, box, { status: "destroying", error: null }, now);
  await dispatchOrFail(env, updated, "down", now);
  return json({ box: boxView(updated) });
});

// ---------------------------------------------------------------- provisioner (GitHub Actions)

route("GET", "/internal/boxes/:id", async (req, env, p) => {
  requireProvisioner(req, env);
  const box = await getBox(env, p.id);
  if (!box) throw new HttpError(404, "no such box");
  const plan = PLANS[box.plan];
  // Regions to try for a new box, in order; once placed, only its own.
  const regions = box.zone ? [box.region] : box.regions.split(",");
  return json({
    id: box.id,
    status: box.status,
    region: box.region,
    regions,
    // Zones offering the plan in those regions (zones.generated.ts), so the
    // provisioner needn't look them up; empty means look them up.
    zones: box.zone ? [] : regions.flatMap((r) => PLAN_ZONES[box.plan]?.[r] ?? []),
    zone: box.zone,
    machine_type: plan.machineType,
    gpu_type: plan.gpuType,
    gpu_count: plan.gpuCount,
    spot: !!plan.spot,
    ssh_user: SSH_USER,
    ssh_public_key: box.ssh_public_key,
    plan: box.plan,
    // Zones that just ran out of this machine type: try them last.
    avoid_zones: box.zone ? [] : await recentStockouts(env, plan.machineType),
    // For the idle watcher on the box (provisioner/terraform/scripts): the
    // token that lets it stop this box, and after how many idle minutes.
    idle_token: await idleToken(env, box.id),
    idle_minutes: idleMinutes(env),
  });
});

// A box may stop itself, and nothing else, with this token (it lives in the
// VM's metadata, readable by its owner). Derived, so nothing is stored.
async function idleToken(env: Env, id: string): Promise<string> {
  if (!env.PROVISIONER_SECRET) throw new HttpError(500, "PROVISIONER_SECRET is not set");
  return hmacSha256Hex(env.PROVISIONER_SECRET, `idle:${id}`);
}

// Minutes of an idle GPU (nothing running on it, nobody connected) before the
// box stops itself; 0 turns it off.
function idleMinutes(env: Env): number {
  return Math.max(0, Math.floor(numVar(env.IDLE_STOP_MINUTES, 5)));
}

// The box's idle watcher: its GPU has been idle for idle_minutes, so stop it
// like `gpushed stop` would (its disk is kept and billed) and tell the owner.
route("POST", "/boxes/:id/idle", async (req, env, p) => {
  const box = await getBox(env, p.id);
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!box || !timingSafeEqual(got, await idleToken(env, p.id))) throw new HttpError(401, "unauthorized");
  if (box.status !== "running") return json({ stopped: false, status: box.status });
  const now = nowSec();
  const stopping = await updateBox(env, box, { status: "stopping" }, now);
  if (!(await dispatchOrRevert(env, stopping, "stop", "running", now))) {
    throw new HttpError(503, "could not reach the provisioner; try again shortly");
  }
  const owner = await env.DB.prepare("SELECT email FROM users WHERE id = ?1").bind(box.user_id).first<{ email: string }>();
  if (owner) {
    try {
      await sendEmail(
        env,
        owner.email,
        "gpushed: your idle GPU box was stopped",
        `Your box ${box.id} had nothing running on its GPU and nobody connected for ${idleMinutes(env)} minutes, ` +
          `so it has been stopped to save you money. Its disk and files are kept (billed at the stopped rate).\n\n` +
          `Resume it with: gpushed start\n`,
      );
    } catch (e) {
      console.error(`idle-stop email for ${box.id} failed`, e);
    }
  }
  return json({ stopped: true });
});

// The box's shutdown hook (provisioner/terraform/scripts/shutdown.sh): Google
// is reclaiming this Spot VM, which stops it with its disk kept. Nothing else
// would tell us, so record it as stopped (billing only the disk from now on)
// and tell the owner. The VM is already going down: no provisioner run.
route("POST", "/boxes/:id/preempted", async (req, env, p) => {
  const box = await getBox(env, p.id);
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!box || !timingSafeEqual(got, await idleToken(env, p.id))) throw new HttpError(401, "unauthorized");
  if (!PLANS[box.plan]?.spot || box.status !== "running") return json({ stopped: false, status: box.status });
  const now = nowSec();
  await updateBox(env, box, { status: "stopped", stopped_at: now, ip: null }, now);
  const owner = await env.DB.prepare("SELECT email FROM users WHERE id = ?1").bind(box.user_id).first<{ email: string }>();
  if (owner) {
    try {
      await sendEmail(
        env,
        owner.email,
        `gpushed: Google reclaimed your ${box.plan.toUpperCase()} Spot box`,
        `Your box ${box.id} runs on a Spot VM, and Google needed the GPU back, so it has been stopped. ` +
          `Its disk and files are kept (billed at the stopped rate); anything that was running was ended.\n\n` +
          `Resume it with: gpushed start (if there's no ${box.plan.toUpperCase()} free right now, try again in a few minutes)\n`,
      );
    } catch (e) {
      console.error(`preempted email for ${box.id} failed`, e);
    }
  }
  return json({ stopped: true });
});

async function recentStockouts(env: Env, machineType: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT zone FROM zone_stockouts WHERE machine_type = ?1 AND at > ?2")
    .bind(machineType, nowSec() - STOCKOUT_SECS)
    .all<{ zone: string }>();
  return results.map((r) => r.zone);
}

// Progress from the provisioner while it works: a short line for the CLI to
// show, and optionally a zone that just ran out of capacity.
route("POST", "/internal/boxes/:id/progress", async (req, env, p) => {
  requireProvisioner(req, env);
  const r = await readJson<{ message?: string; stockout_zone?: string }>(req);
  const box = await getBox(env, p.id);
  if (!box) throw new HttpError(404, "no such box");
  const stmts = [];
  if (typeof r.message === "string") {
    stmts.push(env.DB.prepare("UPDATE boxes SET progress = ?2 WHERE id = ?1").bind(box.id, r.message.slice(0, 200)));
  }
  if (r.stockout_zone !== undefined) {
    if (!isZone(r.stockout_zone)) throw new HttpError(400, "bad zone");
    stmts.push(
      env.DB.prepare(
        "INSERT INTO zone_stockouts (zone, machine_type, at) VALUES (?1, ?2, ?3) ON CONFLICT (zone, machine_type) DO UPDATE SET at = ?3",
      ).bind(r.stockout_zone, PLANS[box.plan].machineType, nowSec()),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true });
});

// The status each action moves a box out of when it finishes.
const IN_PROGRESS: Record<ProvisionAction, Box["status"]> = {
  up: "pending",
  start: "starting",
  stop: "stopping",
  down: "destroying",
};

route("POST", "/internal/boxes/:id/report", async (req, env, p) => {
  requireProvisioner(req, env);
  const r = await readJson<{ action: ProvisionAction; ok: boolean; ip?: string; zone?: string; error?: string }>(req);
  if (!(r.action in IN_PROGRESS)) throw new HttpError(400, "bad action");
  const box = await getBox(env, p.id);
  if (!box) throw new HttpError(404, "no such box");
  const now = nowSec();
  const current = box.status === IN_PROGRESS[r.action];
  // The step is over; and a zone that just took a box has capacity again.
  const done = [env.DB.prepare("UPDATE boxes SET progress = NULL WHERE id = ?1").bind(box.id)];
  if (r.ok && isZone(r.zone)) {
    done.push(
      env.DB.prepare("DELETE FROM zone_stockouts WHERE zone = ?1 AND machine_type = ?2").bind(r.zone, PLANS[box.plan].machineType),
    );
  }
  await env.DB.batch(done);
  box.progress = null;
  const f: Partial<Box> = {};

  if (r.ok) {
    if (r.action === "up" || r.action === "start") {
      f.ip = r.ip ?? box.ip;
      f.zone = r.zone ?? box.zone;
      // Placed in another region than first priced: bill that region's price.
      const region = f.zone ? regionOfZone(f.zone) : box.region;
      if (region !== box.region) {
        const price = planPrice(PLANS[box.plan], region, numVar(env.PREMIUM_PCT, 20));
        if (price) {
          Object.assign(f, { region, hourly_micros: price.hourlyMicros, stopped_hourly_micros: price.stoppedHourlyMicros });
        }
      }
      f.stopped_at = null;
      // The VM exists from here on, whatever the user did meanwhile: bill it.
      if (box.metered_until == null) f.metered_until = now;
      if (current) Object.assign(f, { status: "running", error: null });
    } else if (r.action === "stop" && current) {
      Object.assign(f, { status: "stopped", stopped_at: now, ip: null });
    } else if (r.action === "down") {
      Object.assign(f, { status: "destroyed", ip: null });
    }
  } else if (current) {
    Object.assign(f, { status: "failed", error: String(r.error ?? `${r.action} failed`).slice(0, 500) });
  }

  if (Object.keys(f).length === 0) return json({ box: boxView(box), applied: false });
  // Bill up to now at the old rate before the status (and so the rate) changes.
  const metered = await meterBox(env, box, now);
  let updated = await updateBox(env, metered, f, now);
  if (updated.status === "destroyed") updated = await updateBox(env, updated, { metered_until: null }, now);
  return json({ box: boxView(updated), applied: true });
});
