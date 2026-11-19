// The smartloop API holds the money. A gpushed account is a smartloop account
// (same id), and its credits are one wallet across products: the plan's
// monthly credits first, then top-ups. gpushed spends from it through the
// API's internal routes, authenticated with SMARTLOOP_SERVICE_SECRET.
//
// Amounts are US dollar micros (1e-6 USD), as everywhere in gpushed.
import type { Env } from "./env";

export interface Credits {
  plan_micros: number; // the plan's monthly credits left
  wallet_micros: number; // top-ups
  available_micros: number; // both together: what a box can spend
  plan?: string; // the smartloop plan billing shows: free, paid (Pro), plus, max, partner
}

export interface Spent extends Credits {
  from_plan_micros: number;
  from_wallet_micros: number;
  short_micros: number; // what neither could cover: stop the box
  replayed: boolean; // this ref was spent before; nothing changed
}

export class SmartloopError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(env: Env, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!env.SMARTLOOP_SERVICE_SECRET) throw new SmartloopError(503, "SMARTLOOP_SERVICE_SECRET is not set");
  const res = await fetch(`${env.SMARTLOOP_API}/v1/internal${path}`, {
    method,
    headers: {
      "x-service-secret": env.SMARTLOOP_SERVICE_SECRET,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new SmartloopError(res.status, `smartloop ${method} ${path} failed (HTTP ${res.status}) ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function getCredits(env: Env, userId: string): Promise<Credits> {
  return call<Credits>(env, "GET", `/credits/${encodeURIComponent(userId)}`);
}

// Spend once per ref; a retry with the same ref changes nothing.
export function spendCredits(env: Env, userId: string, amountMicros: number, ref: string): Promise<Spent> {
  return call<Spent>(env, "POST", "/credits/spend", { user_id: userId, amount_micros: amountMicros, ref });
}

// Add credit outside Stripe, once per ref. Returns whether it applied now.
export async function grantCredits(env: Env, userId: string, amountMicros: number, kind: string, ref: string): Promise<boolean> {
  const r = await call<{ applied: boolean }>(env, "POST", "/credits/grant", {
    user_id: userId,
    amount_micros: amountMicros,
    kind,
    ref,
  });
  return r.applied;
}

// A Stripe Checkout that adds credits, charged to the account's smartloop
// customer; smartloop credits the wallet when it's paid.
export async function topupCheckoutUrl(
  env: Env,
  userId: string,
  amountUsd: number,
  successUrl: string,
  cancelUrl: string,
): Promise<string> {
  const r = await call<{ url: string }>(env, "POST", "/topup", {
    user_id: userId,
    amount_usd: amountUsd,
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
  return r.url;
}
