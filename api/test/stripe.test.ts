import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "../src/stripe";
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
