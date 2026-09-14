import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "stonegate-sms-outreach" },
  redact: {
    paths: [
      "req.headers.authorization",
      "*.secret",
      "*.apiKey",
      "*.password",
      "*.token",
      "SMS_PROVIDER_WEBHOOK_SECRET",
    ],
    censor: "[REDACTED]",
  },
});
