import { type Box, type User, credit, getBox, meterBox, runMetering, updateBox } from "./billing";
import { type Env, numVar } from "./env";
import { type ProvisionAction, dispatchProvision } from "./external";
import { DEFAULT_PLAN, PLANS, planPrice } from "./pricing";
import { type CheckoutSession, createCheckoutSession, verifyStripeSignature } from "./stripe";
import { HttpError, boxId, json, nowSec, randomToken, readJson, sha256Hex, timingSafeEqual, usd } from "./util";

const SSH_USER = "boxuser";
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

// Served at api.smartloop.ai/v1/gpushed/* (a Worker route in front of the
// smartloop API); the prefix is optional so local dev can call /me directly.
const PREFIX = "/v1/gpushed";

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname;
  if (path === PREFIX || path.startsWith(PREFIX + "/")) path = path.slice(PREFIX.length) || "/";
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

function boxView(box: Box) {
  return {
    id: box.id,
    plan: box.plan,
    status: box.status,
    region: box.region,
    zone: box.zone,
    ip: box.ip,
    ssh_user: SSH_USER,
    hourly_usd: usd(box.hourly_micros),
    stopped_hourly_usd: usd(box.stopped_hourly_micros),
    error: box.error,
    created_at: box.created_at,
  };
}

function account(env: Env, user: User) {
  return {
    email: user.email,
    balance_usd: usd(user.balance_micros),
    balance_micros: user.balance_micros,
    low_balance: user.balance_micros > 0 && user.balance_micros <= numVar(env.LOW_BALANCE_USD, 2) * 1e6,
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

function html(title: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>${title}</h1><p>${body}</p></body>`,
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
  const user = await smartloopUser(env, String(access_token ?? ""));
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

route("GET", "/plans", async (_req, env) => {
  const premium = numVar(env.PREMIUM_PCT, 20);
  return json({
    default: DEFAULT_PLAN,
    region: env.REGION,
    plans: Object.values(PLANS).map((p) => {
      const price = planPrice(p, premium);
      return {
        id: p.id,
        label: p.label,
        machine_type: p.machineType,
        hourly_usd: usd(price.hourlyMicros),
        stopped_hourly_usd: usd(price.stoppedHourlyMicros),
      };
    }),
  });
});

route("GET", "/me", async (req, env) => {
  const user = await authUser(req, env);
  const box = await activeBox(env, user.id);
  return json({ ...account(env, user), box: box ? boxView(box) : null });
});

route("GET", "/ledger", async (req, env) => {
  const user = await authUser(req, env);
  const { results } = await env.DB.prepare(
    "SELECT amount_micros, kind, ref, created_at FROM ledger WHERE user_id = ?1 ORDER BY id DESC LIMIT 50",
  )
    .bind(user.id)
    .all<{ amount_micros: number; kind: string; ref: string; created_at: number }>();
  return json({
    entries: results.map((e) => ({ amount_usd: usd(e.amount_micros), kind: e.kind, created_at: e.created_at })),
  });
});

route("POST", "/topup", async (req, env) => {
  const user = await authUser(req, env);
  const { amount_usd } = await readJson<{ amount_usd?: number }>(req);
  const min = numVar(env.MIN_TOPUP_USD, 10);
  const amount = Number(amount_usd ?? min);
  if (!Number.isFinite(amount) || amount < min) throw new HttpError(400, `the minimum top-up is $${min}`);
  if (amount > 5000) throw new HttpError(400, "the maximum top-up is $5000");
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, "payments are not configured");
  const url = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
    userId: user.id,
    email: user.email,
    amountCents: Math.round(amount * 100),
    successUrl: `${env.PUBLIC_URL}/topup/done`,
    cancelUrl: `${env.PUBLIC_URL}/topup/cancelled`,
  });
  return json({ url });
});

route("GET", "/topup/done", async () =>
  html("Payment received", "Your balance updates in a few seconds. Check it with <code>gpushed balance</code>."),
);
route("GET", "/topup/cancelled", async () => html("Top-up cancelled", "You weren't charged."));

route("POST", "/stripe/webhook", async (req, env) => {
  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET ?? "", nowSec());
  if (!ok) throw new HttpError(400, "bad signature");
  const event = JSON.parse(payload) as { type: string; data: { object: CheckoutSession } };
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const s = event.data.object;
    const userId = s.metadata?.user_id ?? s.client_reference_id;
    if (s.payment_status === "paid" && userId && s.amount_total && (s.currency ?? "usd") === "usd") {
      await credit(env, userId, s.amount_total * 10_000, "topup", `stripe:${s.id}`, nowSec());
    }
  }
  return json({ received: true });
});

// ---------------------------------------------------------------- boxes

route("POST", "/box", async (req, env) => {
  const user = await authUser(req, env);
  const body = await readJson<{ plan?: string; ssh_public_key?: string }>(req);
  const plan = PLANS[body.plan ?? DEFAULT_PLAN];
  if (!plan) throw new HttpError(400, `unknown plan; choose one of: ${Object.keys(PLANS).join(", ")}`);
  // Drop the key's comment: it ends up in GCE metadata as "user:type key".
  const key = String(body.ssh_public_key ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
  if (!SSH_KEY_RE.test(key) || key.length > 4096) throw new HttpError(400, "invalid SSH public key");

  const existing = await activeBox(env, user.id);
  if (existing) throw new HttpError(409, `you already have a box (${existing.id}, ${existing.status}); run gpushed down first`);

  const price = planPrice(plan, numVar(env.PREMIUM_PCT, 20));
  if (user.balance_micros < price.hourlyMicros) {
    throw new HttpError(
      402,
      `balance $${usd(user.balance_micros)} is less than one hour of ${plan.id} ($${usd(price.hourlyMicros)}); run gpushed topup`,
    );
  }
  const now = nowSec();
  const box: Box = {
    id: boxId(),
    user_id: user.id,
    plan: plan.id,
    status: "pending",
    region: env.REGION,
    zone: null,
    ip: null,
    ssh_public_key: key,
    hourly_micros: price.hourlyMicros,
    stopped_hourly_micros: price.stoppedHourlyMicros,
    metered_until: null,
    stopped_at: null,
    error: null,
    created_at: now,
    updated_at: now,
  };
  await env.DB.prepare(
    `INSERT INTO boxes (id, user_id, plan, status, region, ssh_public_key, hourly_micros, stopped_hourly_micros, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  )
    .bind(box.id, box.user_id, box.plan, box.status, box.region, box.ssh_public_key, box.hourly_micros, box.stopped_hourly_micros, now)
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
  if (user.balance_micros < box.hourly_micros) {
    throw new HttpError(402, `balance $${usd(user.balance_micros)} is less than one hour of use; run gpushed topup`);
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
  return json({
    id: box.id,
    status: box.status,
    region: box.region,
    zone: box.zone,
    machine_type: plan.machineType,
    gpu_type: plan.gpuType,
    gpu_count: plan.gpuCount,
    ssh_user: SSH_USER,
    ssh_public_key: box.ssh_public_key,
  });
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
  const f: Partial<Box> = {};

  if (r.ok) {
    if (r.action === "up" || r.action === "start") {
      f.ip = r.ip ?? box.ip;
      f.zone = r.zone ?? box.zone;
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
