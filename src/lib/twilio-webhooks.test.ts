import twilio from "twilio";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOutbound: vi.fn(),
  retainStatus: vi.fn(),
  markStatus: vi.fn(),
  persistStatus: vi.fn(),
  recordInbound: vi.fn(),
  suppressPhoneGlobally: vi.fn(),
  suppressPhoneGloballyWhileDispatchLocked: vi.fn(),
  withSmsPhoneDispatchLock: vi.fn(
    async (_normalizedPhone: string, operation: () => Promise<unknown>) =>
      operation(),
  ),
  getEnv: vi.fn(() => ({
    APP_BASE_URL: "https://sms.stonegate.test",
    TWILIO_AUTH_TOKEN: "twilio-test-auth-token",
  })),
}));

vi.mock("@/lib/db", () => ({
  db: {
    smsOutboundMessage: { findFirst: mocks.findOutbound },
    smsStatusEvent: {
      createMany: mocks.retainStatus,
      updateMany: mocks.markStatus,
    },
  },
}));
vi.mock("@/lib/sms-operations", () => ({
  persistSmsDeliveryStatus: mocks.persistStatus,
}));
vi.mock("@/lib/sms-conversations", () => ({
  recordSmsInboundMessage: mocks.recordInbound,
}));
vi.mock("@/lib/suppression", () => ({
  suppressPhoneGlobally: mocks.suppressPhoneGlobally,
  suppressPhoneGloballyWhileDispatchLocked:
    mocks.suppressPhoneGloballyWhileDispatchLocked,
}));
vi.mock("@/lib/sms-dispatch-lock", () => ({
  withSmsPhoneDispatchLock: mocks.withSmsPhoneDispatchLock,
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));

import {
  EMPTY_TWIML,
  emptyTwimlResponse,
  isKnownTwilioMessageStatus,
  mapTwilioMessageStatus,
  parseTwilioFormBody,
  parseTwilioInboundWebhook,
  parseTwilioStatusWebhook,
  processTwilioInboundWebhook,
  processTwilioStatusWebhook,
  reconstructTwilioWebhookUrl,
  TWILIO_WEBHOOK_LIMITS,
  twilioStatusReplayId,
  TwilioWebhookPayloadError,
  TwilioWebhookPayloadTooLargeError,
  TwilioWebhookSignatureError,
  validateTwilioWebhookRequest,
} from "./twilio-webhooks";
import { POST as processTwilioInboundRoute } from "@/app/api/webhooks/twilio/inbound/route";
import { POST as processTwilioStatusRoute } from "@/app/api/webhooks/twilio/status/route";

const authToken = "twilio-test-auth-token";
const appBaseUrl = "https://sms.stonegate.test";
const messageSid = `SM${"a".repeat(32)}`;

beforeEach(() => {
  vi.clearAllMocks();
});

function signedRequest(body: string, incomingUrl: string) {
  const params = parseTwilioFormBody(body);
  const publicUrl = reconstructTwilioWebhookUrl(appBaseUrl, incomingUrl);
  const signature = twilio.getExpectedTwilioSignature(
    authToken,
    publicUrl,
    params,
  );
  return new Request(incomingUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-twilio-signature": signature,
    },
    body,
  });
}

describe("Twilio webhook validation", () => {
  it("uses the trusted public host, incoming path/query, and every form field", async () => {
    const incomingUrl =
      "http://internal-render-host:10000/api/webhooks/twilio/status?source=a%20b";
    const body = new URLSearchParams({
      MessageSid: messageSid,
      MessageStatus: "delivered",
      FutureTwilioField: "must-be-signed",
    }).toString();
    const validated = await validateTwilioWebhookRequest({
      request: signedRequest(body, incomingUrl),
      appBaseUrl,
      authToken,
    });

    expect(validated.publicUrl).toBe(
      "https://sms.stonegate.test/api/webhooks/twilio/status?source=a%20b",
    );
    expect(validated.params).toMatchObject({
      MessageSid: messageSid,
      FutureTwilioField: "must-be-signed",
    });

    const tamperedBody = body.replace("must-be-signed", "changed");
    await expect(
      validateTwilioWebhookRequest({
        request: new Request(incomingUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": signedRequest(body, incomingUrl).headers.get(
              "x-twilio-signature",
            )!,
          },
          body: tamperedBody,
        }),
        appBaseUrl,
        authToken,
      }),
    ).rejects.toBeInstanceOf(TwilioWebhookSignatureError);
  });

  it("rejects a missing signature and a non-form payload", async () => {
    await expect(
      validateTwilioWebhookRequest({
        request: new Request("https://internal/api/webhooks/twilio/status", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `MessageSid=${messageSid}`,
        }),
        appBaseUrl,
        authToken,
      }),
    ).rejects.toBeInstanceOf(TwilioWebhookSignatureError);

    await expect(
      validateTwilioWebhookRequest({
        request: new Request("https://internal/api/webhooks/twilio/status", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-twilio-signature": "not-relevant",
          },
          body: "{}",
        }),
        appBaseUrl,
        authToken,
      }),
    ).rejects.toBeInstanceOf(TwilioWebhookPayloadError);
  });

  it("bounds the raw body, form-part count, decoded keys, and decoded values", () => {
    expect(() =>
      parseTwilioFormBody("x".repeat(TWILIO_WEBHOOK_LIMITS.maxBodyBytes + 1)),
    ).toThrow(TwilioWebhookPayloadTooLargeError);
    expect(() =>
      parseTwilioFormBody(
        Array.from(
          { length: TWILIO_WEBHOOK_LIMITS.maxParameters + 1 },
          (_, index) => `field${index}=value`,
        ).join("&"),
      ),
    ).toThrow(TwilioWebhookPayloadTooLargeError);
    expect(() =>
      parseTwilioFormBody(
        `${"k".repeat(TWILIO_WEBHOOK_LIMITS.maxKeyBytes + 1)}=value`,
      ),
    ).toThrow(TwilioWebhookPayloadTooLargeError);
    expect(() =>
      parseTwilioFormBody(
        `field=${"v".repeat(TWILIO_WEBHOOK_LIMITS.maxValueBytes + 1)}`,
      ),
    ).toThrow(TwilioWebhookPayloadTooLargeError);
  });

  it.each([
    ["status", processTwilioStatusRoute],
    ["inbound", processTwilioInboundRoute],
  ])("returns 413 for an oversized %s webhook", async (route, handler) => {
    const response = await handler(
      new Request(`http://internal-render-host/api/webhooks/twilio/${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": "not-evaluated-for-an-oversized-body",
        },
        body: `Body=${"x".repeat(TWILIO_WEBHOOK_LIMITS.maxBodyBytes)}`,
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Twilio webhook payload exceeds configured limits",
    });
  });
});

describe("Twilio status parsing", () => {
  it("maps provider states without treating acceptance as sent", () => {
    expect(mapTwilioMessageStatus("accepted")).toBe("ACCEPTED");
    expect(mapTwilioMessageStatus("queued")).toBe("ACCEPTED");
    expect(mapTwilioMessageStatus("sending")).toBe("ACCEPTED");
    expect(mapTwilioMessageStatus("sent")).toBe("SENT");
    expect(mapTwilioMessageStatus("delivered")).toBe("DELIVERED");
    expect(mapTwilioMessageStatus("undelivered")).toBe("UNDELIVERED");
    expect(mapTwilioMessageStatus("failed")).toBe("FAILED");
    expect(mapTwilioMessageStatus("scheduled")).toBeNull();
    expect(mapTwilioMessageStatus("read")).toBeNull();
    expect(isKnownTwilioMessageStatus("queued")).toBe(true);
    expect(isKnownTwilioMessageStatus("future-status")).toBe(false);
  });

  it("preserves unknown fields and creates an order-independent replay ID", () => {
    const params = {
      MessageSid: messageSid,
      MessageStatus: "delivered",
      NumSegments: "2",
      From: "+12025550999",
      FutureTwilioField: "preserved",
    };
    const reordered = {
      FutureTwilioField: "preserved",
      NumSegments: "2",
      From: "+12025550999",
      MessageStatus: "delivered",
      MessageSid: messageSid,
    };
    const occurredAt = new Date("2030-01-02T03:04:05.000Z");
    const parsed = parseTwilioStatusWebhook(params, occurredAt);

    expect(parsed).toMatchObject({
      providerMessageId: messageSid,
      providerStatus: "delivered",
      outcome: "DELIVERED",
      recognizedStatus: true,
      actualSegmentCount: 2,
      fromPhone: "+12025550999",
      occurredAt,
      rawPayload: { FutureTwilioField: "preserved" },
    });
    expect(twilioStatusReplayId(params)).toBe(twilioStatusReplayId(reordered));
  });
});

describe("Twilio inbound parsing", () => {
  it("parses media and provider opt-out metadata without composing a reply", async () => {
    const receivedAt = new Date("2030-02-03T04:05:06.000Z");
    const parsed = parseTwilioInboundWebhook(
      {
        MessageSid: messageSid,
        From: "+12025550123",
        To: "+12025550999",
        Body: "  STOP  ",
        NumMedia: "2",
        MediaUrl0: "https://api.twilio.test/media/one",
        MediaContentType0: "image/jpeg",
        MediaUrl1: "https://api.twilio.test/media/two",
        MediaContentType1: "image/png",
        OptOutType: "STOP",
        FutureTwilioField: "preserved",
      },
      receivedAt,
    );

    expect(parsed).toMatchObject({
      providerMessageId: messageSid,
      from: "+12025550123",
      to: "+12025550999",
      body: "  STOP  ",
      numMedia: 2,
      optOutType: "STOP",
      providerOptOut: true,
      receivedAt,
      media: [
        {
          index: 0,
          url: "https://api.twilio.test/media/one",
          contentType: "image/jpeg",
        },
        {
          index: 1,
          url: "https://api.twilio.test/media/two",
          contentType: "image/png",
        },
      ],
      rawPayload: { FutureTwilioField: "preserved" },
    });
    expect(EMPTY_TWIML).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
    const response = emptyTwimlResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/xml; charset=utf-8",
    );
    expect(await response.text()).toBe(EMPTY_TWIML);
  });
});

describe("Twilio webhook persistence adapters", () => {
  it("projects a matched final status through the existing monotonic writer", async () => {
    mocks.findOutbound.mockResolvedValue({ id: "message-id" });
    mocks.persistStatus.mockResolvedValue({
      updated: true,
      reason: "recorded",
      messageStatus: "DELIVERED",
    });
    const event = parseTwilioStatusWebhook({
      MessageSid: messageSid,
      MessageStatus: "delivered",
      From: "+12025550999",
      FutureTwilioField: "preserved",
    });

    await processTwilioStatusWebhook(event);

    expect(mocks.persistStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "message-id",
        providerKey: "twilio",
        providerMessageId: messageSid,
        providerStatus: "delivered",
        outcome: "DELIVERED",
        fromPhone: "+12025550999",
        rawPayload: expect.objectContaining({
          FutureTwilioField: "preserved",
        }),
      }),
    );
    expect(mocks.retainStatus).not.toHaveBeenCalled();
  });

  it("retains a future status without inventing a canonical state", async () => {
    mocks.findOutbound.mockResolvedValue({ id: "message-id" });
    mocks.retainStatus.mockResolvedValue({ count: 1 });
    const event = parseTwilioStatusWebhook({
      MessageSid: messageSid,
      MessageStatus: "future-status",
      FutureTwilioField: "preserved",
    });

    const result = await processTwilioStatusWebhook(event);

    expect(mocks.persistStatus).not.toHaveBeenCalled();
    expect(mocks.retainStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            messageId: "message-id",
            status: null,
            providerStatus: "future-status",
            rawPayload: expect.objectContaining({
              FutureTwilioField: "preserved",
            }),
          }),
        ],
        skipDuplicates: true,
      }),
    );
    expect(result).toMatchObject({
      matched: true,
      applied: false,
      recognizedStatus: false,
    });
  });

  it("turns Twilio's recipient opt-out error into replay-safe global suppression", async () => {
    mocks.findOutbound.mockResolvedValue({
      id: "message-id",
      fromPhone: "+12025550999",
      toPhone: "+12025550123",
    });
    mocks.persistStatus.mockResolvedValue({
      updated: true,
      reason: "recorded",
      messageStatus: "FAILED",
    });
    const event = parseTwilioStatusWebhook({
      MessageSid: messageSid,
      MessageStatus: "failed",
      ErrorCode: "21610",
      To: "+12025550123",
    });

    await processTwilioStatusWebhook(event);

    expect(mocks.persistStatus).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "21610", outcome: "FAILED" }),
    );
    expect(mocks.withSmsPhoneDispatchLock).toHaveBeenCalledWith(
      "+12025550123",
      expect.any(Function),
    );
    expect(mocks.suppressPhoneGloballyWhileDispatchLocked).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedPhone: "+12025550123",
        reason: "PROVIDER_DNC",
        source: "twilio_provider_opt_out",
        idempotencyKey: `twilio-provider-opt-out:${event.providerEventId}`,
      }),
    );
    expect(mocks.persistStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.suppressPhoneGloballyWhileDispatchLocked.mock
        .invocationCallOrder[0],
    );
    expect(mocks.markStatus).toHaveBeenCalledWith({
      where: {
        providerKey: "twilio",
        providerEventId: event.providerEventId,
        messageId: "message-id",
      },
      data: { processedAt: expect.any(Date), processingError: null },
    });
  });

  it("does not suppress a callback recipient unless the status matches a local outbound", async () => {
    mocks.findOutbound.mockResolvedValue(null);
    mocks.retainStatus.mockResolvedValue({ count: 1 });
    const event = parseTwilioStatusWebhook({
      MessageSid: messageSid,
      MessageStatus: "failed",
      ErrorCode: "21610",
      To: "+12025550123",
    });

    const result = await processTwilioStatusWebhook(event);

    expect(result.matched).toBe(false);
    expect(mocks.suppressPhoneGlobally).not.toHaveBeenCalled();
    expect(
      mocks.suppressPhoneGloballyWhileDispatchLocked,
    ).not.toHaveBeenCalled();
  });

  it("does not suppress when callback To conflicts with the matched recipient", async () => {
    mocks.findOutbound.mockResolvedValue({
      id: "message-id",
      fromPhone: "+12025550999",
      toPhone: "+12025550123",
    });
    mocks.persistStatus.mockResolvedValue({
      updated: true,
      reason: "recorded",
      messageStatus: "FAILED",
    });
    const event = parseTwilioStatusWebhook({
      MessageSid: messageSid,
      MessageStatus: "failed",
      ErrorCode: "21610",
      To: "+12025550124",
    });

    await processTwilioStatusWebhook(event);

    expect(mocks.suppressPhoneGlobally).not.toHaveBeenCalled();
    expect(
      mocks.suppressPhoneGloballyWhileDispatchLocked,
    ).not.toHaveBeenCalled();
  });

  it("passes inbound media and STOP metadata to the existing inbox writer", async () => {
    mocks.recordInbound.mockResolvedValue({
      messageId: "inbound-id",
      duplicate: false,
    });
    const event = parseTwilioInboundWebhook({
      MessageSid: messageSid,
      From: "+12025550123",
      To: "+12025550999",
      Body: "STOP",
      NumMedia: "1",
      MediaUrl0: "https://api.twilio.test/media/one",
      MediaContentType0: "image/jpeg",
      OptOutType: "STOP",
    });

    await processTwilioInboundWebhook(event);

    expect(mocks.recordInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKey: "twilio",
        providerMessageId: messageSid,
        providerOptOut: true,
        rawPayload: expect.objectContaining({
          parsedMedia: [
            {
              index: 0,
              url: "https://api.twilio.test/media/one",
              contentType: "image/jpeg",
            },
          ],
          optOutType: "STOP",
        }),
      }),
    );
  });
});
