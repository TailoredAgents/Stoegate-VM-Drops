export interface TTSGenerateInput {
  text: string;
  voiceId: string;
  modelId: string;
  settings?: Record<string, unknown>;
}

export interface TTSGenerateResult {
  bytes: Uint8Array;
  contentType: string;
  providerGenerationId?: string;
  characterCount: number;
  durationSeconds?: number;
}

export interface TTSProvider {
  readonly name: string;
  generate(input: TTSGenerateInput): Promise<TTSGenerateResult>;
}

export interface AudioStorageProvider {
  readonly name: string;
  put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void>;
  getReadUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

export type RVMMedia =
  | { strategy: "hosted_url"; url: string; audioType: "mp3" | "wav" }
  | { strategy: "recording_id"; recordingId: string };

export interface RVMSendInput {
  foreignId: string;
  phoneNumber: string;
  media: RVMMedia;
  postalCode?: string;
  callbackUrl: string;
}

export interface RVMSendResult {
  status: "dry_run" | "queued" | "sent";
  providerMessageId?: string;
  rawResponse: Record<string, unknown>;
}

export interface RVMProvider {
  readonly name: string;
  readonly live: boolean;
  assertReadyForLiveSend(): Promise<void>;
  send(input: RVMSendInput): Promise<RVMSendResult>;
}
