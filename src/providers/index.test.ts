import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnvironment = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = {
    ...originalEnvironment,
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://example.invalid/stonegate_test",
    APP_BASE_URL: "https://stonegate.example.com",
    SESSION_SECRET: "test-session-secret-at-least-32-characters",
    SMS_PROVIDER: "twilio",
    SMS_LIVE_SENDS_ENABLED: "false",
    TWILIO_PRODUCTION_APPROVED: "false",
  };
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
});

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("SMS provider selection", () => {
  it("keeps dry-run selected while the global live gate is off", async () => {
    process.env.TWILIO_PRODUCTION_APPROVED = "true";
    const { getSmsProvider } = await import("./index");

    expect(getSmsProvider()).toMatchObject({
      name: "dry-run-sms",
      live: false,
    });
  });

  it("selects Twilio only after both live gates and credentials validate", async () => {
    process.env.SMS_LIVE_SENDS_ENABLED = "true";
    process.env.TWILIO_PRODUCTION_APPROVED = "true";
    process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`;
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
    process.env.TWILIO_MESSAGING_SERVICE_SID = `MG${"b".repeat(32)}`;
    const { getSmsProvider } = await import("./index");

    expect(getSmsProvider()).toMatchObject({ name: "twilio", live: true });
  });
});
