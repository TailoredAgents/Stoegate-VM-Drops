import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { QUEUES, startBoss } from "@/jobs/queues";
import { DropCowboyRVMProvider } from "@/providers/dropcowboy";
import { checkElevenLabsVoice } from "@/providers/elevenlabs";
import { CloudflareR2StorageProvider } from "@/providers/r2";

export type ProviderHealthState = "healthy" | "unhealthy" | "not_configured";
export interface ProviderHealthResult {
  key: "postgresql" | "worker_queue" | "elevenlabs" | "r2" | "drop_cowboy";
  label: string;
  state: ProviderHealthState;
  detail: string;
}

async function diagnostic(
  key: ProviderHealthResult["key"],
  label: string,
  configured: boolean,
  check: () => Promise<string>,
): Promise<ProviderHealthResult> {
  if (!configured)
    return {
      key,
      label,
      state: "not_configured",
      detail: "Required environment values are incomplete.",
    };
  try {
    return { key, label, state: "healthy", detail: await check() };
  } catch (error) {
    return {
      key,
      label,
      state: "unhealthy",
      detail: error instanceof Error ? error.message : "Check failed.",
    };
  }
}

export async function getProviderHealth(): Promise<ProviderHealthResult[]> {
  const env = getEnv();
  return Promise.all([
    diagnostic("postgresql", "PostgreSQL", true, async () => {
      await db.$queryRaw`SELECT 1`;
      return "Connected and query succeeded.";
    }),
    diagnostic("worker_queue", "Worker queue", true, async () => {
      const boss = await startBoss();
      const queues = await boss.getQueues(Object.values(QUEUES));
      if (queues.length !== Object.values(QUEUES).length)
        throw new Error("One or more application queues are missing.");
      return `${queues.length} durable PostgreSQL queues are available.`;
    }),
    diagnostic(
      "elevenlabs",
      "ElevenLabs",
      Boolean(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID),
      async () => {
        const voice = await checkElevenLabsVoice(
          env.ELEVENLABS_API_KEY!,
          env.ELEVENLABS_VOICE_ID!,
        );
        return `Authenticated; voice “${voice.name}” is accessible.`;
      },
    ),
    diagnostic(
      "r2",
      "Cloudflare R2",
      Boolean(
        env.R2_ENDPOINT &&
        env.R2_ACCESS_KEY_ID &&
        env.R2_SECRET_ACCESS_KEY &&
        env.R2_BUCKET_NAME,
      ),
      async () => {
        const storage = new CloudflareR2StorageProvider(
          env.R2_BUCKET_NAME!,
          env.R2_ENDPOINT!,
          env.R2_ACCESS_KEY_ID!,
          env.R2_SECRET_ACCESS_KEY!,
          env.R2_PRESIGNED_URL_TTL_SECONDS,
        );
        await storage.checkBucket();
        return "Authenticated; bucket HEAD succeeded.";
      },
    ),
    diagnostic(
      "drop_cowboy",
      "Drop Cowboy",
      Boolean(
        env.DROP_COWBOY_TEAM_ID &&
        env.DROP_COWBOY_SECRET &&
        env.DROP_COWBOY_BRAND_ID &&
        env.DROP_COWBOY_FORWARDING_NUMBER,
      ),
      async () => {
        const provider = new DropCowboyRVMProvider({
          endpoint: env.DROP_COWBOY_API_ENDPOINT,
          teamId: env.DROP_COWBOY_TEAM_ID!,
          secret: env.DROP_COWBOY_SECRET!,
          brandId: env.DROP_COWBOY_BRAND_ID!,
          forwardingNumber: env.DROP_COWBOY_FORWARDING_NUMBER!,
        });
        const brand = await provider.checkBrand();
        return `Authenticated; registered API brand “${brand.dba_name ?? brand.company_name ?? brand.brand_id}” is available.`;
      },
    ),
  ]);
}
