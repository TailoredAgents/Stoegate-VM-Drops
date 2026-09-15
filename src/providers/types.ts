export type SMSMetadataValue = string | number | boolean | null;

/** Provider-neutral input for one outbound SMS attempt. */
export interface SMSOutboundMessage {
  /** Stable application key used to make retries idempotent. */
  idempotencyKey: string;
  to: string;
  from?: string;
  /** The complete rendered body. Providers must not silently truncate it. */
  body: string;
  clientReference?: string;
  callbackUrl?: string;
  metadata?: Readonly<Record<string, SMSMetadataValue>>;
}

export type SMSOutboundStatus =
  | "dry_run"
  | "accepted"
  | "queued"
  | "sent"
  | "delivered"
  | "undelivered"
  | "rejected"
  | "failed"
  | "unknown";

export interface SMSSendResult {
  status: SMSOutboundStatus;
  providerMessageId?: string;
  /** The sender actually selected by the provider or its Messaging Service. */
  from?: string;
  segments?: number;
  costMicros?: number;
  currency?: string;
  failureCode?: string;
  failureReason?: string;
  /** Stable hash of the behavior-affecting request fields. */
  requestFingerprint: string;
  rawResponse: Readonly<Record<string, unknown>>;
}

/** Normalized inbound message shape for a future provider webhook adapter. */
export interface SMSInboundMessage {
  providerMessageId: string;
  providerConversationId?: string;
  from: string;
  to: string;
  body: string;
  receivedAt: Date;
  media?: ReadonlyArray<{
    url?: string;
    contentType?: string;
    providerMediaId?: string;
  }>;
  providerOptOut?: boolean;
  rawPayload?: Readonly<Record<string, unknown>>;
}

/** Normalized delivery update shape for a future provider webhook adapter. */
export interface SMSStatusUpdate {
  providerEventId: string;
  providerMessageId: string;
  clientReference?: string;
  status: Exclude<SMSOutboundStatus, "dry_run">;
  occurredAt: Date;
  segments?: number;
  costMicros?: number;
  currency?: string;
  errorCode?: string;
  errorMessage?: string;
  rawPayload?: Readonly<Record<string, unknown>>;
}

export interface SMSProvider {
  readonly name: string;
  readonly live: boolean;
  assertReadyForLiveSend(): Promise<void>;
  send(input: SMSOutboundMessage): Promise<SMSSendResult>;
}
