import { describe, expect, it } from "vitest";
import { verifyStripeWebhookSignature } from "./stripe-signature";
import { entitledPlanForStatus } from "./billing-policy";

describe("Stripe raw-body webhook verification", () => {
  it("accepts a valid v1 HMAC and rejects tampering and stale timestamps", async () => {
    const body = JSON.stringify({ id: "evt_test", type: "checkout.session.completed" });
    const secret = "whsec_test_secret";
    const timestamp = 1_786_315_200;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
    const signature = Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const header = `t=${timestamp},v1=${signature}`;
    expect(await verifyStripeWebhookSignature(body, header, secret, timestamp * 1_000)).toBe(true);
    expect(await verifyStripeWebhookSignature(`${body} `, header, secret, timestamp * 1_000)).toBe(false);
    expect(await verifyStripeWebhookSignature(body, header, secret, (timestamp + 301) * 1_000)).toBe(false);
    expect(await verifyStripeWebhookSignature(body, `t=not-a-number,v1=${signature}`, secret, timestamp * 1_000)).toBe(false);
  });
});

describe("Stripe entitlement fail-closed policy", () => {
  it.each([
    ["trialing", "team"],
    ["active", "enterprise"],
    ["past_due", "team"],
  ] as const)("keeps %s subscriptions entitled", (status, plan) => {
    expect(entitledPlanForStatus(status, plan)).toBe(plan);
  });

  it.each(["configuration-required", "checkout-open", "incomplete", "unpaid", "paused", "canceled"] as const)("downgrades %s subscriptions to demo", (status) => {
    expect(entitledPlanForStatus(status, "enterprise")).toBe("demo");
  });
});
