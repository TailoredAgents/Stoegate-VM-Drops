import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "stonegate-vm-drops" },
  redact: {
    paths: [
      "req.headers.authorization",
      "*.secret",
      "*.apiKey",
      "*.password",
      "*.token",
      "DROP_COWBOY_SECRET",
      "ELEVENLABS_API_KEY",
    ],
    censor: "[REDACTED]",
  },
});
