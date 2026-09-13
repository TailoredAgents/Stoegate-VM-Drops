import { z } from "zod";
import type { TTSGenerateInput, TTSProvider } from "./types";

const errorSchema = z.object({ detail: z.unknown().optional() }).passthrough();
const voiceSchema = z
  .object({
    voice_id: z.string(),
    name: z.string(),
    category: z.string().optional(),
  })
  .passthrough();

export async function checkElevenLabsVoice(apiKey: string, voiceId: string) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`,
    {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const raw: unknown = await response.json().catch(() => ({}));
  const parsed = voiceSchema.safeParse(raw);
  if (!response.ok || !parsed.success)
    throw new Error(`ElevenLabs voice lookup failed (${response.status})`);
  return parsed.data;
}

export class ElevenLabsTTSProvider implements TTSProvider {
  readonly name = "elevenlabs";
  constructor(
    private readonly apiKey: string,
    private readonly outputFormat = "mp3_44100_128",
  ) {}

  async generate(input: TTSGenerateInput) {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}?output_format=${encodeURIComponent(this.outputFormat)}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: input.text,
          model_id: input.modelId,
          voice_settings: input.settings,
        }),
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!response.ok) {
      const body = errorSchema.safeParse(
        await response.json().catch(() => ({})),
      );
      throw new Error(
        `ElevenLabs request failed (${response.status}): ${JSON.stringify(body.success ? body.data.detail : "unknown")}`,
      );
    }
    const characterCost = Number(response.headers.get("character-cost"));
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
      providerGenerationId: response.headers.get("request-id") ?? undefined,
      characterCount:
        Number.isFinite(characterCost) && characterCost > 0
          ? characterCost
          : input.text.length,
    };
  }
}
