import type {
  AudioStorageProvider,
  RVMProvider,
  RVMSendInput,
  TTSGenerateInput,
  TTSProvider,
} from "./types";

function makePreviewWav(durationSeconds = 1.2): Uint8Array {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * durationSeconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const envelope = Math.min(1, i / 300) * Math.min(1, (samples - i) / 300);
    buffer.writeInt16LE(
      Math.round(
        Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 1800 * envelope,
      ),
      44 + i * 2,
    );
  }
  return buffer;
}

export class DryRunTTSProvider implements TTSProvider {
  readonly name = "dry-run-tts";
  async generate(input: TTSGenerateInput) {
    return {
      bytes: makePreviewWav(),
      contentType: "audio/wav",
      providerGenerationId: `dry-${input.voiceId}-${input.text.length}`,
      characterCount: input.text.length,
      durationSeconds: 1.2,
    };
  }
}

export class DryRunAudioStorageProvider implements AudioStorageProvider {
  readonly name = "dry-run-storage";
  async put(): Promise<void> {}
  async getReadUrl(key: string): Promise<string> {
    return `/api/audio/dry-run?key=${encodeURIComponent(key)}`;
  }
}

export class DryRunRVMProvider implements RVMProvider {
  readonly name = "dry-run-rvm";
  readonly live = false;
  async assertReadyForLiveSend(): Promise<void> {}
  async send(input: RVMSendInput) {
    return {
      status: "dry_run" as const,
      providerMessageId: `dry-${input.foreignId}`,
      rawResponse: { dryRun: true, foreign_id: input.foreignId },
    };
  }
}

export { makePreviewWav };
