import { type Box, type User, credit, getBox, meterBox, runMetering, updateBox } from "./billing";
import { type Env, numVar } from "./env";
import { type ProvisionAction, dispatchProvision, sendEmail } from "./external";
import { DEFAULT_PLAN, PLANS, planPrice } from "./pricing";
import { type CheckoutSession, createCheckoutSession, verifyStripeSignature } from "./stripe";
import { HttpError, boxId, json, nowSec, randomToken, readJson, sha256Hex, timingSafeEqual, usd } from "./util";

const SSH_USER = "boxuser";
const LOGIN_TTL_SEC = 15 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SSH_KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+={0,3}$/;
// Statuses of a box whose VM may exist; a user has at most one such box.
const ACTIVE = "status != 'destroyed'";

type Handler = (req: Request, env: Env, params: Record<string, string>) => Promise<Response>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), h]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      for (const [method, re, h] of routes) {
        const m = url.pathname.match(re);
        if (m && req.method === method) return await h(req, env, m.groups ?? {});
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runMetering(env, nowSec()));
  },
};

// ---------------------------------------------------------------- helpers

async function authUser(req: Request, env: Env): Promise<User> {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer (gp_[A-Za-z0-9_-]+)$/);
  if (!m) throw new HttpError(401, "not signed in; run: gpushed login");
  const user = await env.DB.prepare(
    "SELECT u.* FROM users u JOIN api_tokens t ON t.user_id = u.id WHERE t.token_hash = ?1",
  )
    .bind(await sha256Hex(m[1]))
    .first<User>();
  if (!user) throw new HttpError(401, "session expired or revoked; run: gpushed login");
  return user;
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

route("POST", "/v1/auth/start", async (req, env) => {
  const { email: raw } = await readJson<{ email?: string }>(req);
  const email = String(raw ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "enter a valid email address");
  const now = nowSec();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_requests WHERE email = ?1 AND created_at > ?2")
    .bind(email, now - LOGIN_TTL_SEC)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= 5) throw new HttpError(429, "too many sign-in attempts; wait a few minutes");

  const id = randomToken(12);
  const verify = randomToken();
  const poll = randomToken();
  await env.DB.prepare(
    "INSERT INTO login_requests (id, email, verify_hash, poll_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, email, await sha256Hex(verify), await sha256Hex(poll), now, now + LOGIN_TTL_SEC)
    .run();
  const link = `${env.PUBLIC_URL}/v1/auth/verify?id=${id}&t=${verify}`;
  await sendEmail(
    env,
    email,
    "Sign in to gpushed",
    `Open this link to finish signing in to gpushed:\n\n${link}\n\nIt expires in 15 minutes. ` +
      `If you didn't try to sign in, ignore this email.\n`,
  );
  return json({ request_id: id, poll_token: poll, expires_in: LOGIN_TTL_SEC });
});

route("GET", "/v1/auth/verify", async (req, env) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const t = url.searchParams.get("t") ?? "";
  const r = await env.DB.prepare("SELECT verify_hash, expires_at FROM login_requests WHERE id = ?1")
    .bind(id)
    .first<{ verify_hash: string; expires_at: number }>();
  if (!r || !timingSafeEqual(r.verify_hash, await sha256Hex(t))) {
    return html("Link not valid", "Run <code>gpushed login</code> again to get a new one.");
  }
  if (r.expires_at < nowSec()) return html("Link expired", "Run <code>gpushed login</code> again.");
  await env.DB.prepare("UPDATE login_requests SET verified_at = ?1 WHERE id = ?2 AND verified_at IS NULL")
    .bind(nowSec(), id)
    .run();
  return html("You're signed in", "Go back to your terminal; gpushed has picked it up.");
});

route("POST", "/v1/auth/poll", async (req, env) => {
  const { request_id, poll_token } = await readJson<{ request_id?: string; poll_token?: string }>(req);
  const r = await env.DB.prepare("SELECT * FROM login_requests WHERE id = ?1")
    .bind(String(request_id ?? ""))
    .first<{ id: string; email: string; poll_hash: string; expires_at: number; verified_at: number | null; claimed_at: number | null }>();
  if (!r || !timingSafeEqual(r.poll_hash, await sha256Hex(String(poll_token ?? "")))) {
    throw new HttpError(404, "unknown sign-in request");
  }
  const now = nowSec();
  if (r.claimed_at) throw new HttpError(410, "sign-in already completed");
  if (!r.verified_at) {
    if (r.expires_at < now) throw new HttpError(410, "sign-in link expired; run gpushed login again");
    return json({ status: "pending" }, 202);
  }
  const claimed = await env.DB.prepare("UPDATE login_requests SET claimed_at = ?1 WHERE id = ?2 AND claimed_at IS NULL")
    .bind(now, r.id)
    .run();
  if (claimed.meta.changes !== 1) throw new HttpError(410, "sign-in already completed");

  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(email) DO NOTHING")
    .bind(crypto.randomUUID(), r.email, now)
    .run();
  const user = (await env.DB.prepare("SELECT * FROM users WHERE email = ?1").bind(r.email).first<User>())!;
  const token = "gp_" + randomToken();
  await env.DB.prepare("INSERT INTO api_tokens (token_hash, user_id, created_at) VALUES (?1, ?2, ?3)")
    .bind(await sha256Hex(token), user.id, now)
    .run();
  return json({ status: "ok", token, account: account(env, user) });
});

route("POST", "/v1/auth/logout", async (req, env) => {
  await authUser(req, env);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  await env.DB.prepare("DELETE FROM api_tokens WHERE token_hash = ?1").bind(await sha256Hex(token)).run();
  return json({ status: "ok" });
});

// ---------------------------------------------------------------- account and billing

route("GET", "/v1/plans", async (_req, env) => {
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

route("GET", "/v1/me", async (req, env) => {
  const user = await authUser(req, env);
  const box = await activeBox(env, user.id);
  return json({ ...account(env, user), box: box ? boxView(box) : null });
});

route("GET", "/v1/ledger", async (req, env) => {
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

route("POST", "/v1/topup", async (req, env) => {
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

route("POST", "/v1/stripe/webhook", async (req, env) => {
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

route("POST", "/v1/box", async (req, env) => {
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

route("GET", "/v1/box", async (req, env) => {
  const user = await authUser(req, env);
  const box = await activeBox(env, user.id);
  if (!box) throw new HttpError(404, "you have no box; create one with gpushed up");
  return json({ box: boxView(box), account: account(env, user) });
});

route("POST", "/v1/box/stop", async (req, env) => {
  const user = await authUser(req, env);
  const box = await activeBox(env, user.id);
  if (!box) throw new HttpError(404, "you have no box");
  if (box.status !== "running") throw new HttpError(409, `box is ${box.status}; only a running box can be stopped`);
  const now = nowSec();
  const updated = await updateBox(env, box, { status: "stopping" }, now);
  await dispatchOrFail(env, updated, "stop", now);
  return json({ box: boxView(updated) });
});

route("POST", "/v1/box/start", async (req, env) => {
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

route("DELETE", "/v1/box", async (req, env) => {
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
