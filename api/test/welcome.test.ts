import { afterEach, describe, expect, it, vi } from "vitest";
import { welcomeEmail, welcomeOnFirstTopup } from "../src/billing";
import { renderText } from "../src/email";
import type { Env } from "../src/env";
import { createCheckoutSession } from "../src/stripe";

// A D1 stand-in whose only query returns `row`.
function envWith(row: { email: string; balance_micros: number; topups: number } | null): Env {
  const stmt = { bind: () => stmt, first: async () => row };
  return {
    DB: { prepare: () => stmt },
    RESEND_API_KEY: "re_test",
    EMAIL_FROM: "gpushed <noreply@example.com>",
  } as unknown as Env;
}

function stubFetch(body: unknown = { url: "https://checkout.stripe.com/x" }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("welcomeOnFirstTopup", () => {
  it("emails the gpushed welcome after the first top-up", async () => {
    const calls = stubFetch({ id: "em_1" });
    expect(await welcomeOnFirstTopup(envWith({ email: "a@example.com", balance_micros: 25e6, topups: 1 }), "u1")).toBe(true);
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent.to).toBe("a@example.com");
    expect(sent.from).toBe("gpushed <noreply@example.com>");
    expect(sent.subject).toMatch(/Welcome to gpushed/);
    expect(sent.text).toContain("$25.00");
    expect(sent.html).toContain("$25.00");
  });
  it("doesn't email on later top-ups or unknown users", async () => {
    const calls = stubFetch();
    expect(await welcomeOnFirstTopup(envWith({ email: "a@example.com", balance_micros: 1, topups: 2 }), "u1")).toBe(false);
    expect(await welcomeOnFirstTopup(envWith(null), "u1")).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it("swallows a failed send", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await welcomeOnFirstTopup(envWith({ email: "a@example.com", balance_micros: 1, topups: 1 }), "u1")).toBe(false);
  });
  it("points to the commands and the site", () => {
    const t = renderText(welcomeEmail(10e6));
    for (const s of ["gpushed up", "gpushed ssh", "gpushed down", "gpushed topup", "https://gpushed.dev"]) expect(t).toContain(s);
  });
});

describe("createCheckoutSession", () => {
  it("tags the session and payment as gpushed's", async () => {
    const calls = stubFetch();
    await createCheckoutSession("sk_test", { userId: "u1", email: "a@example.com", amountCents: 10000, successUrl: "s", cancelUrl: "c" });
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("metadata[app]")).toBe("gpushed");
    expect(body.get("payment_intent_data[metadata][app]")).toBe("gpushed");
  });
});
