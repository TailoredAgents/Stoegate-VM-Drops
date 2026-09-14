import { describe, expect, it } from "vitest";

import { parseCanonicalSmsWebhook } from "@/lib/sms-webhooks";

describe("canonical SMS webhook contract", () => {
  it("accepts a normalized delivery event", () => {
    expect(
      parseCanonicalSmsWebhook(
        JSON.stringify({
          type: "delivery_status",
          providerKey: "future-provider",
          providerEventId: "event-1",
          providerMessageId: "message-1",
          status: "delivered",
          occurredAt: "2026-09-14T18:00:00.000Z",
          segments: 2,
          costMicros: 2500,
          rawPayload: { original_status: "delivered", request_id: "req-1" },
        }),
      ),
    ).toMatchObject({
      status: "delivered",
      segments: 2,
      rawPayload: { original_status: "delivered", request_id: "req-1" },
    });
  });

  it("accepts provider opt-out and media metadata on an inbound event", () => {
    expect(
      parseCanonicalSmsWebhook(
        JSON.stringify({
          type: "inbound_message",
          providerKey: "future-provider",
          providerMessageId: "reply-1",
          from: "+15555550100",
          to: "+15555550200",
          body: "STOP",
          receivedAt: "2026-09-14T18:01:00.000Z",
          providerOptOut: true,
          media: [{ contentType: "image/jpeg", providerMediaId: "media-1" }],
        }),
      ),
    ).toMatchObject({ type: "inbound_message", providerOptOut: true });
  });

  it("rejects unrecognized provider statuses", () => {
    expect(() =>
      parseCanonicalSmsWebhook(
        JSON.stringify({
          type: "delivery_status",
          providerKey: "future-provider",
          providerEventId: "event-1",
          providerMessageId: "message-1",
          status: "mystery",
          occurredAt: "2026-09-14T18:00:00.000Z",
        }),
      ),
    ).toThrow();
  });
});
