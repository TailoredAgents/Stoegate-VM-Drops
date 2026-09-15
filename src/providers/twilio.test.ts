import { describe, expect, it, vi } from "vitest";

import {
  normalizeTwilioMessageStatus,
  type TwilioMessageClient,
  type TwilioMessageResource,
  TwilioSMSProvider,
  type TwilioSMSProviderConfig,
} from "./twilio";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const MESSAGING_SERVICE_SID = `MG${"b".repeat(32)}`;

const liveConfig: TwilioSMSProviderConfig = {
  accountSid: ACCOUNT_SID,
  authToken: "test-auth-token",
  messagingServiceSid: MESSAGING_SERVICE_SID,
  appBaseUrl: "https://stonegate.example.com/app/path",
  liveSendsEnabled: true,
  productionApproved: true,
};

function providerWithResponse(
  response: TwilioMessageResource,
  config: TwilioSMSProviderConfig = liveConfig,
) {
  const create = vi.fn().mockResolvedValue(response);
  const client: TwilioMessageClient = { messages: { create } };
  const createClient = vi.fn(() => client);
  return {
    provider: new TwilioSMSProvider(config, { createClient }),
    create,
    createClient,
  };
}

describe("TwilioSMSProvider", () => {
  it("sends only supported Messaging Service fields and normalizes the response", async () => {
    const response: TwilioMessageResource = {
      sid: `SM${"c".repeat(32)}`,
      status: "accepted",
      numSegments: "2",
      from: "+15125550999",
      to: "+15125550123",
      price: "-0.0075",
      priceUnit: "usd",
      messagingServiceSid: MESSAGING_SERVICE_SID,
      errorCode: null,
      errorMessage: null,
    };
    const { provider, create, createClient } = providerWithResponse(response);

    const result = await provider.send({
      idempotencyKey: "campaign-contact-42:sms:1",
      to: "+15125550123",
      from: "+15125550000",
      body: "Hi Sam, are you interested?",
      clientReference: "campaign-contact-42",
      callbackUrl: "https://attacker.invalid/callback",
      metadata: { ignored: true },
    });

    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(ACCOUNT_SID, "test-auth-token");
    expect(create).toHaveBeenCalledExactlyOnceWith({
      to: "+15125550123",
      body: "Hi Sam, are you interested?",
      messagingServiceSid: MESSAGING_SERVICE_SID,
      statusCallback:
        "https://stonegate.example.com/api/webhooks/twilio/status",
    });
    expect(result).toMatchObject({
      status: "accepted",
      providerMessageId: response.sid,
      from: "+15125550999",
      segments: 2,
      costMicros: 7_500,
      currency: "USD",
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      rawResponse: {
        sid: response.sid,
        status: "accepted",
        numSegments: "2",
        from: "+15125550999",
        price: "-0.0075",
        priceUnit: "usd",
      },
    });
  });

  it.each([
    { liveSendsEnabled: false, productionApproved: true },
    { liveSendsEnabled: true, productionApproved: false },
    { liveSendsEnabled: false, productionApproved: false },
  ])(
    "blocks client creation unless both live gates are true: %o",
    async (gates) => {
      const createClient = vi.fn();
      const provider = new TwilioSMSProvider(
        { ...liveConfig, ...gates },
        { createClient },
      );

      await expect(
        provider.send({
          idempotencyKey: "key",
          to: "+15125550123",
          body: "Hi",
        }),
      ).rejects.toThrow();
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it("omits initial placeholder segments, sender, and price", async () => {
    const { provider } = providerWithResponse({
      sid: `SM${"d".repeat(32)}`,
      status: "accepted",
      numSegments: "0",
      from: null,
      price: null,
      priceUnit: "usd",
    });

    const result = await provider.send({
      idempotencyKey: "key",
      to: "+15125550123",
      body: "Hi",
    });

    expect(result).not.toHaveProperty("segments");
    expect(result).not.toHaveProperty("from");
    expect(result).not.toHaveProperty("costMicros");
    expect(result).not.toHaveProperty("currency");
  });

  it("does not record an actual price without a valid currency unit", async () => {
    const { provider } = providerWithResponse({
      sid: `SM${"f".repeat(32)}`,
      status: "accepted",
      price: "-0.0075",
      priceUnit: null,
    });

    const result = await provider.send({
      idempotencyKey: "key",
      to: "+15125550123",
      body: "Hi",
    });

    expect(result).not.toHaveProperty("costMicros");
    expect(result).not.toHaveProperty("currency");
  });

  it("returns Twilio failure details without inventing a successful status", async () => {
    const { provider } = providerWithResponse({
      sid: `SM${"e".repeat(32)}`,
      status: "failed",
      errorCode: 30_007,
      errorMessage: "Message filtered",
    });

    await expect(
      provider.send({
        idempotencyKey: "key",
        to: "+15125550123",
        body: "Hi",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      failureCode: "30007",
      failureReason: "Message filtered",
    });
  });

  it("preserves a deterministic Twilio 4xx rejection without calling it a timeout", async () => {
    const create = vi.fn().mockRejectedValue(
      Object.assign(new Error("The recipient has unsubscribed"), {
        code: 21_610,
        status: 400,
        moreInfo: "https://www.twilio.com/docs/api/errors/21610",
      }),
    );
    const provider = new TwilioSMSProvider(liveConfig, {
      createClient: () => ({ messages: { create } }),
    });

    await expect(
      provider.send({
        idempotencyKey: "key",
        to: "+15125550123",
        body: "Hi",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      failureCode: "21610",
      failureReason: "The recipient has unsubscribed",
      rawResponse: {
        code: "21610",
        httpStatus: 400,
      },
    });
  });

  it("keeps network and ambiguous server failures throwable", async () => {
    const create = vi.fn().mockRejectedValue(new Error("connection reset"));
    const provider = new TwilioSMSProvider(liveConfig, {
      createClient: () => ({ messages: { create } }),
    });

    await expect(
      provider.send({
        idempotencyKey: "key",
        to: "+15125550123",
        body: "Hi",
      }),
    ).rejects.toThrow("connection reset");
  });

  it("maps every Twilio-only lifecycle status conservatively", () => {
    expect(normalizeTwilioMessageStatus("scheduled")).toBe("queued");
    expect(normalizeTwilioMessageStatus("sending")).toBe("queued");
    expect(normalizeTwilioMessageStatus("read")).toBe("delivered");
    expect(normalizeTwilioMessageStatus("partially_delivered")).toBe(
      "undelivered",
    );
    expect(normalizeTwilioMessageStatus("canceled")).toBe("rejected");
    expect(normalizeTwilioMessageStatus("received")).toBe("unknown");
  });
});
