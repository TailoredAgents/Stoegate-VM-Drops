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
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_VOICE_ID: z.string().optional(),
    ELEVENLABS_MODEL_ID: z.string().default("eleven_flash_v2_5"),
    ELEVENLABS_OUTPUT_FORMAT: z
      .string()
      .regex(/^mp3_\d+_\d+$/)
      .default("mp3_44100_128"),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET_NAME: z.string().optional(),
    R2_ENDPOINT: z.url().optional(),
    R2_PRESIGNED_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(604800)
      .default(86400),
    DROP_COWBOY_API_ENDPOINT: z
      .url()
      .default("https://api.dropcowboy.com/v1/rvm"),
    DROP_COWBOY_TEAM_ID: z.string().optional(),
    DROP_COWBOY_SECRET: z.string().optional(),
    DROP_COWBOY_BRAND_ID: z.string().optional(),
    DROP_COWBOY_FORWARDING_NUMBER: z.string().optional(),
    DROP_COWBOY_WEBHOOK_SECRET: z.string().optional(),
    STONEGATE_INTEGRATION_API_KEY: z.string().min(24),
    CALLBACK_LOOKBACK_DAYS: z.coerce.number().int().positive().default(30),
    AUDIO_GENERATION_LIVE_ENABLED: booleanString,
    RVM_LIVE_SENDS_ENABLED: booleanString,
    MAX_LIVE_CAMPAIGN_SEND_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .default(10),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(4),
    DEFAULT_CAMPAIGN_SEND_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .default(1000),
    PREVIEW_SAMPLE_SIZE: z.coerce.number().int().min(1).max(25).default(10),
    LOG_LEVEL: z.string().default("info"),
  })
  .superRefine((env, ctx) => {
    const audioRequired = [
      "ELEVENLABS_API_KEY",
      "ELEVENLABS_VOICE_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET_NAME",
      "R2_ENDPOINT",
    ] as const;
    if (env.AUDIO_GENERATION_LIVE_ENABLED) {
      for (const key of audioRequired) {
        if (!env[key])
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when real audio generation is enabled`,
          });
      }
    }
    if (!env.RVM_LIVE_SENDS_ENABLED) return;
    if (!env.AUDIO_GENERATION_LIVE_ENABLED) {
      ctx.addIssue({
        code: "custom",
        path: ["AUDIO_GENERATION_LIVE_ENABLED"],
        message: "Real audio generation must be enabled before live sends",
      });
    }
    const liveRequired = [
      "DROP_COWBOY_TEAM_ID",
      "DROP_COWBOY_SECRET",
      "DROP_COWBOY_BRAND_ID",
      "DROP_COWBOY_FORWARDING_NUMBER",
      "DROP_COWBOY_WEBHOOK_SECRET",
    ] as const;
    for (const key of liveRequired) {
      if (!env[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when live sends are enabled`,
        });
      }
    }
    if (!/^\+[1-9]\d{7,14}$/.test(env.DROP_COWBOY_FORWARDING_NUMBER ?? "")) {
      ctx.addIssue({
        code: "custom",
        path: ["DROP_COWBOY_FORWARDING_NUMBER"],
        message: "A valid E.164 forwarding number is required",
      });
    }
    if (!env.APP_BASE_URL.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["APP_BASE_URL"],
        message: "HTTPS is required for live webhook callbacks",
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

export function isLiveSendingEnabled(): boolean {
  return process.env.RVM_LIVE_SENDS_ENABLED === "true";
}
