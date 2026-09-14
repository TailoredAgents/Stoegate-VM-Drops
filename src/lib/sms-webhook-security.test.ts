import { describe, expect, it } from "vitest";
import {
  smsWebhookSignature,
  verifySmsWebhookSignature,
} from "./sms-webhook-security";

describe("provider-neutral SMS webhook authentication", () => {
  it("accepts the exact HMAC and rejects altered payloads", () => {
    const secret = "test-webhook-secret-at-least-24-characters";
    const body = JSON.stringify({ eventId: "evt-1", type: "inbound" });
    const signature = smsWebhookSignature(body, secret);
    expect(verifySmsWebhookSignature(body, signature, secret)).toBe(true);
    expect(verifySmsWebhookSignature(`${body} `, signature, secret)).toBe(
      false,
    );
  });

  it("fails closed when configuration or signature is missing", () => {
    expect(verifySmsWebhookSignature("{}", null, "secret")).toBe(false);
    expect(verifySmsWebhookSignature("{}", "sha256=abc", undefined)).toBe(
      false,
    );
  });
});
