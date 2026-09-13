import { getEnv } from "@/lib/env";
import {
  DryRunAudioStorageProvider,
  DryRunRVMProvider,
  DryRunTTSProvider,
} from "./dry-run";
import { DropCowboyRVMProvider } from "./dropcowboy";
import { ElevenLabsTTSProvider } from "./elevenlabs";
import { CloudflareR2StorageProvider } from "./r2";
import type { AudioStorageProvider, RVMProvider, TTSProvider } from "./types";

let providers:
  | { tts: TTSProvider; storage: AudioStorageProvider; rvm: RVMProvider }
  | undefined;

export function getProviders(): {
  tts: TTSProvider;
  storage: AudioStorageProvider;
  rvm: RVMProvider;
} {
  if (providers) return providers;
  const env = getEnv();
  const tts = env.AUDIO_GENERATION_LIVE_ENABLED
    ? new ElevenLabsTTSProvider(
        env.ELEVENLABS_API_KEY!,
        env.ELEVENLABS_OUTPUT_FORMAT,
      )
    : new DryRunTTSProvider();
  const storage = env.AUDIO_GENERATION_LIVE_ENABLED
    ? new CloudflareR2StorageProvider(
        env.R2_BUCKET_NAME!,
        env.R2_ENDPOINT!,
        env.R2_ACCESS_KEY_ID!,
        env.R2_SECRET_ACCESS_KEY!,
        env.R2_PRESIGNED_URL_TTL_SECONDS,
      )
    : new DryRunAudioStorageProvider();
  if (!env.RVM_LIVE_SENDS_ENABLED) {
    providers = { tts, storage, rvm: new DryRunRVMProvider() };
    return providers;
  }
  providers = {
    tts,
    storage,
    rvm: new DropCowboyRVMProvider({
      endpoint: env.DROP_COWBOY_API_ENDPOINT,
      teamId: env.DROP_COWBOY_TEAM_ID!,
      secret: env.DROP_COWBOY_SECRET!,
      brandId: env.DROP_COWBOY_BRAND_ID!,
      forwardingNumber: env.DROP_COWBOY_FORWARDING_NUMBER!,
    }),
  };
  return providers;
}
