import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnvironment = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = {
    ...originalEnvironment,
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://example.invalid/stonegate_test",
    APP_BASE_URL: "http://localhost:3000",
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    SMS_PROVIDER: "dry-run",
    SMS_LIVE_SENDS_ENABLED: "false",
  };
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env.TWILIO_PRODUCTION_APPROVED;
});

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("SMS environment safety", () => {
  it("defaults to provider-neutral dry-run operation", async () => {
    const { getEnv } = await import("./env");
    expect(getEnv()).toMatchObject({
      SMS_PROVIDER: "dry-run",
      SMS_LIVE_SENDS_ENABLED: false,
      TWILIO_PRODUCTION_APPROVED: false,
      DEFAULT_DAILY_SMS_LIMIT: 2000,
      DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS: 48,
    });
  });

  it("treats blank optional Twilio placeholders as unconfigured", async () => {
    process.env.TWILIO_ACCOUNT_SID = "";
    process.env.TWILIO_AUTH_TOKEN = "";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "";
    const { getEnv } = await import("./env");

    expect(getEnv()).toMatchObject({
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_MESSAGING_SERVICE_SID: undefined,
    });
  });

  it("normalizes provider keys before they are persisted or compared", async () => {
    process.env.SMS_PROVIDER = " TwIlIo ";
    const { getEnv } = await import("./env");

    expect(getEnv().SMS_PROVIDER).toBe("twilio");
  });

  it("rejects enabling live sends with the dry-run provider", async () => {
    process.env.SMS_LIVE_SENDS_ENABLED = "true";
    process.env.APP_BASE_URL = "https://sms.example.com";
    const { getEnv } = await import("./env");
    expect(() => getEnv()).toThrow(
      "A production SMS provider must be implemented and selected",
    );
  });

  it("requires authenticated callbacks for a future live adapter", async () => {
    process.env.SMS_LIVE_SENDS_ENABLED = "true";
    process.env.SMS_PROVIDER = "future-provider";
    process.env.APP_BASE_URL = "https://sms.example.com";
    const { getEnv } = await import("./env");
    expect(() => getEnv()).toThrow(
      "A webhook authentication secret is required before live SMS is enabled",
    );
  });

  it("blocks Twilio until production sending is separately approved", async () => {
    process.env.SMS_LIVE_SENDS_ENABLED = "true";
    process.env.SMS_PROVIDER = "twilio";
    process.env.APP_BASE_URL = "https://sms.example.com";
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`;
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
    process.env.TWILIO_MESSAGING_SERVICE_SID = `MG${"b".repeat(32)}`;
    const { getEnv } = await import("./env");

    expect(() => getEnv()).toThrow(
      "Twilio production sending must be explicitly approved",
    );
  });

  it("requires every Twilio credential before live sending", async () => {
    process.env.SMS_LIVE_SENDS_ENABLED = "true";
    process.env.SMS_PROVIDER = "twilio";
    process.env.APP_BASE_URL = "https://sms.example.com";
    process.env.TWILIO_PRODUCTION_APPROVED = "true";
    const { getEnv } = await import("./env");

    expect(() => getEnv()).toThrow(
      "TWILIO_ACCOUNT_SID is required for live Twilio sending",
    );
    expect(() => getEnv()).toThrow(
      "TWILIO_AUTH_TOKEN is required for live Twilio sending",
    );
    expect(() => getEnv()).toThrow(
      "TWILIO_MESSAGING_SERVICE_SID is required for live Twilio sending",
    );
  });

  it("accepts fully approved Twilio production configuration", async () => {
    process.env.SMS_LIVE_SENDS_ENABLED = "true";
    process.env.SMS_PROVIDER = "twilio";
    process.env.APP_BASE_URL = "https://sms.example.com/base/path";
    process.env.TWILIO_PRODUCTION_APPROVED = "true";
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`;
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
    process.env.TWILIO_MESSAGING_SERVICE_SID = `MG${"b".repeat(32)}`;
    const { getEnv } = await import("./env");

    expect(getEnv()).toMatchObject({
      SMS_PROVIDER: "twilio",
      SMS_LIVE_SENDS_ENABLED: true,
      TWILIO_PRODUCTION_APPROVED: true,
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_MESSAGING_SERVICE_SID: `MG${"b".repeat(32)}`,
    });
  });
});
