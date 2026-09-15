import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

function optionalEnvironmentValue<T extends z.ZodType>(schema: T) {
  return z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    schema.optional(),
  );
}

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
    OPENAI_API_KEY: optionalEnvironmentValue(z.string().trim().min(1)),
    OPENAI_MODEL: z.string().trim().min(1).default("gpt-6-astra"),
    OPENAI_TEMPLATE_DRAFTING_ENABLED: booleanString,
    SMS_LIVE_SENDS_ENABLED: booleanString,
    SMS_PROVIDER: z.string().trim().toLowerCase().min(1).default("dry-run"),
    SMS_PROVIDER_WEBHOOK_SECRET: z.string().min(24).optional(),
    TWILIO_ACCOUNT_SID: optionalEnvironmentValue(
      z
        .string()
        .trim()
        .regex(/^AC[0-9a-fA-F]{32}$/, "Must be a valid Twilio Account SID"),
    ),
    TWILIO_AUTH_TOKEN: optionalEnvironmentValue(z.string().trim().min(1)),
    TWILIO_MESSAGING_SERVICE_SID: optionalEnvironmentValue(
      z
        .string()
        .trim()
        .regex(
          /^MG[0-9a-fA-F]{32}$/,
          "Must be a valid Twilio Messaging Service SID",
        ),
    ),
    TWILIO_PRODUCTION_APPROVED: booleanString,
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
    if (env.OPENAI_TEMPLATE_DRAFTING_ENABLED && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message:
          "OPENAI_API_KEY is required when OpenAI template drafting is enabled",
      });
    }
    if (!env.SMS_LIVE_SENDS_ENABLED) return;
    const provider = env.SMS_PROVIDER.toLowerCase();
    if (provider === "dry-run") {
      ctx.addIssue({
        code: "custom",
        path: ["SMS_PROVIDER"],
        message: "A production SMS provider must be implemented and selected",
      });
    }
    if (provider === "twilio") {
      if (!env.TWILIO_PRODUCTION_APPROVED) {
        ctx.addIssue({
          code: "custom",
          path: ["TWILIO_PRODUCTION_APPROVED"],
          message: "Twilio production sending must be explicitly approved",
        });
      }
      for (const key of [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_MESSAGING_SERVICE_SID",
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required for live Twilio sending`,
          });
        }
      }
    } else if (!env.SMS_PROVIDER_WEBHOOK_SECRET) {
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
