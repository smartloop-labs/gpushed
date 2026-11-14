import { hmacSha256Hex, timingSafeEqual } from "./util";

// Verify a Stripe-Signature header (https://docs.stripe.com/webhooks#verify-manually).
export async function verifyStripeSignature(
  payload: string,
  header: string | null,
  secret: string,
  now: number,
  toleranceSec = 300,
): Promise<boolean> {
  if (!header || !secret) return false;
  const pairs = header.split(",").map((p) => {
    const i = p.indexOf("=");
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
  });
  const t = pairs.find(([k]) => k === "t")?.[1];
  const sigs = pairs.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(now - Number(t)) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${payload}`);
  return sigs.some((s) => timingSafeEqual(s, expected));
}

export async function createCheckoutSession(
  secretKey: string,
  opts: { userId: string; email: string; amountCents: number; successUrl: string; cancelUrl: string },
): Promise<string> {
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(opts.amountCents),
    "line_items[0][price_data][product_data][name]": "gpushed credit",
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
    client_reference_id: opts.userId,
    customer_email: opts.email,
    "metadata[user_id]": opts.userId,
    "payment_intent_data[metadata][user_id]": opts.userId,
    // Promotion codes give free credit: the webhook credits the amount before
    // discounts (see topupCents), so a 100%-off code is a free top-up.
    allow_promotion_codes: "true",
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = (await r.json()) as { url?: string; error?: { message?: string } };
  if (!r.ok || !data.url) throw new Error(`Stripe checkout failed: ${data.error?.message ?? r.status}`);
  return data.url;
}

export interface CheckoutSession {
  id: string;
  payment_status: string;
  amount_total: number | null;
  amount_subtotal?: number | null;
  currency: string | null;
  metadata?: Record<string, string> | null;
  client_reference_id?: string | null;
}

// The USD cents a completed top-up session is worth: the top-up amount before
// any promotion code, so coupons add free credit rather than shrink it. A
// fully discounted session completes as "no_payment_required". Returns 0 for
// sessions that should not be credited.
export function topupCents(s: CheckoutSession): number {
  if (s.payment_status !== "paid" && s.payment_status !== "no_payment_required") return 0;
  if ((s.currency ?? "usd") !== "usd") return 0;
  const cents = s.amount_subtotal ?? s.amount_total ?? 0;
  return cents > 0 ? cents : 0;
}
