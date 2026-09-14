import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().min(1),
    APP_BASE_URL: z.url(),
    SESSION_SECRET: z.string().min(32),
    SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
    ADMIN_EMAIL: z.email().optional(),
    ADMIN_PASSWORD: z.string().min(12).optional(),
    ADMIN_PASSWORD_HASH: z.string().optional(),
    SMS_LIVE_SENDS_ENABLED: booleanString,
    SMS_PROVIDER: z.string().trim().min(1).default("dry-run"),
    SMS_PROVIDER_WEBHOOK_SECRET: z.string().min(24).optional(),
    DEFAULT_DAILY_SMS_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(2000),
    MAX_LIVE_SMS_CAMPAIGN_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(10),
    MAX_LIVE_DAILY_SMS_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(10),
    DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(48),
    PREVIEW_SAMPLE_SIZE: z.coerce.number().int().min(1).max(25).default(10),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    LOG_LEVEL: z.string().default("info"),
  })
  .superRefine((env, ctx) => {
    if (!env.SMS_LIVE_SENDS_ENABLED) return;
    if (env.SMS_PROVIDER.toLowerCase() === "dry-run") {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_PROVIDER"],
        message: "A production SMS provider must be implemented and selected",
      });
    }
    if (!env.SMS_PROVIDER_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_PROVIDER_WEBHOOK_SECRET"],
        message:
          "A webhook authentication secret is required before live SMS is enabled",
      });
    }
    if (!env.APP_BASE_URL.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_BASE_URL"],
        message: "HTTPS is required before live provider callbacks are enabled",
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | undefined;

export function getEnv(): AppEnv {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const message = result.error.issues
      .map(
        (issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`,
      )
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  cached = result.data;
  return cached;
}
