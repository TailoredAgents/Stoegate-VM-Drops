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
      DEFAULT_DAILY_SMS_LIMIT: 2000,
      DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS: 48,
    });
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
});
