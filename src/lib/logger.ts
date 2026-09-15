import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "stonegate-sms-outreach" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-twilio-signature']",
      "*.secret",
      "*.apiKey",
      "*.authToken",
      "*.password",
      "*.token",
      "SMS_PROVIDER_WEBHOOK_SECRET",
      "TWILIO_AUTH_TOKEN",
      "OPENAI_API_KEY",
    ],
    censor: "[REDACTED]",
  },
});
