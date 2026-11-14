import { describe, expect, it } from "vitest";
import { topupCents, verifyStripeSignature } from "../src/stripe";
import { hmacSha256Hex } from "../src/util";

const secret = "whsec_test";
const payload = '{"id":"evt_1"}';

async function header(t: number, body = payload, key = secret) {
  return `t=${t},v1=${await hmacSha256Hex(key, `${t}.${body}`)}`;
}

describe("verifyStripeSignature", () => {
  it("accepts a valid signature", async () => {
    expect(await verifyStripeSignature(payload, await header(1000), secret, 1000)).toBe(true);
  });
  it("accepts when any v1 signature matches", async () => {
    const h = `t=1000,v1=deadbeef,${(await header(1000)).split(",")[1]}`;
    expect(await verifyStripeSignature(payload, h, secret, 1000)).toBe(true);
  });
  it("rejects a tampered body", async () => {
    expect(await verifyStripeSignature('{"id":"evt_2"}', await header(1000), secret, 1000)).toBe(false);
  });
  it("rejects the wrong secret", async () => {
    expect(await verifyStripeSignature(payload, await header(1000, payload, "other"), secret, 1000)).toBe(false);
  });
  it("rejects old timestamps", async () => {
    expect(await verifyStripeSignature(payload, await header(1000), secret, 1000 + 301)).toBe(false);
  });
  it("rejects missing headers and secrets", async () => {
    expect(await verifyStripeSignature(payload, null, secret, 1000)).toBe(false);
    expect(await verifyStripeSignature(payload, await header(1000), "", 1000)).toBe(false);
    expect(await verifyStripeSignature(payload, "garbage", secret, 1000)).toBe(false);
  });
});

describe("topupCents", () => {
  const base = { id: "cs_1", currency: "usd", amount_subtotal: 2000, amount_total: 2000, payment_status: "paid" };

  it("credits a paid top-up", () => {
    expect(topupCents(base)).toBe(2000);
  });

  it("credits the amount before a partial promotion code", () => {
    expect(topupCents({ ...base, amount_total: 1000 })).toBe(2000);
  });

  it("credits a fully discounted top-up", () => {
    expect(topupCents({ ...base, amount_total: 0, payment_status: "no_payment_required" })).toBe(2000);
  });

  it("falls back to amount_total without a subtotal", () => {
    expect(topupCents({ ...base, amount_subtotal: undefined })).toBe(2000);
  });

  it("does not credit unpaid or non-USD sessions", () => {
    expect(topupCents({ ...base, payment_status: "unpaid" })).toBe(0);
    expect(topupCents({ ...base, currency: "eur" })).toBe(0);
    expect(topupCents({ ...base, amount_subtotal: 0, amount_total: 0 })).toBe(0);
  });
});
