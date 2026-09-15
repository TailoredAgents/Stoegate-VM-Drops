import { createHash } from "node:crypto";

import twilio from "twilio";

import type {
  SMSOutboundMessage,
  SMSOutboundStatus,
  SMSProvider,
  SMSSendResult,
} from "./types";

export interface TwilioMessageCreateRequest {
  to: string;
  body: string;
  messagingServiceSid: string;
  statusCallback: string;
}

export interface TwilioMessageResource {
  sid: string;
  status: string;
  numSegments?: string | null;
  from?: string | null;
  to?: string | null;
  price?: string | null;
  priceUnit?: string | null;
  messagingServiceSid?: string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
}

export interface TwilioMessageClient {
  messages: {
    create(input: TwilioMessageCreateRequest): Promise<TwilioMessageResource>;
  };
}

export type TwilioClientFactory = (
  accountSid: string,
  authToken: string,
) => TwilioMessageClient;

export interface TwilioSMSProviderConfig {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  appBaseUrl: string;
  liveSendsEnabled: boolean;
  productionApproved: boolean;
}

export interface TwilioSMSProviderDependencies {
  createClient?: TwilioClientFactory;
}

const defaultClientFactory: TwilioClientFactory = (accountSid, authToken) =>
  twilio(accountSid, authToken);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredTrimmed(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalTrimmed(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function assertSid(value: string, prefix: "AC" | "MG", field: string): string {
  const normalized = requiredTrimmed(value, field);
  if (!new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function buildStatusCallback(appBaseUrl: string): string {
  const baseUrl = new URL(appBaseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new Error("Twilio status callbacks require an HTTPS APP_BASE_URL");
  }
  return new URL("/api/webhooks/twilio/status", baseUrl).toString();
}

function positiveInteger(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function priceMicros(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const micros = Math.round(Math.abs(parsed) * 1_000_000);
  return Number.isSafeInteger(micros) && micros <= 2_147_483_647
    ? micros
    : undefined;
}

function currencyCode(value: string | null | undefined): string | undefined {
  const normalized = optionalTrimmed(value)?.toUpperCase();
  return normalized && /^[A-Z]{3}$/.test(normalized) ? normalized : undefined;
}

function deterministicTwilioRejection(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    moreInfo?: unknown;
  };
  if (
    typeof candidate.code !== "number" ||
    typeof candidate.status !== "number" ||
    !Number.isInteger(candidate.code) ||
    !Number.isInteger(candidate.status) ||
    candidate.status < 400 ||
    candidate.status >= 500
  ) {
    return null;
  }
  const message =
    typeof candidate.message === "string"
      ? candidate.message
          .replace(/[\r\n]+/g, " ")
          .replace(
            /(?:auth[_ -]?token|password|secret)=?[^\s,;]*/gi,
            "credential=[redacted]",
          )
          .slice(0, 500)
      : "Twilio rejected the message request";
  const moreInfo =
    typeof candidate.moreInfo === "string" &&
    candidate.moreInfo.startsWith("https://www.twilio.com/")
      ? candidate.moreInfo
      : undefined;
  return {
    code: String(candidate.code),
    status: candidate.status,
    message,
    moreInfo,
  };
}

export function normalizeTwilioMessageStatus(
  status: string,
): SMSOutboundStatus {
  switch (status.trim().toLowerCase()) {
    case "accepted":
      return "accepted";
    case "scheduled":
    case "queued":
    case "sending":
      return "queued";
    case "sent":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "undelivered":
    case "partially_delivered":
      return "undelivered";
    case "canceled":
      return "rejected";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function rawTwilioResponse(
  message: TwilioMessageResource,
): Readonly<Record<string, unknown>> {
  return {
    sid: message.sid,
    status: message.status,
    numSegments: message.numSegments ?? null,
    from: message.from ?? null,
    to: message.to ?? null,
    price: message.price ?? null,
    priceUnit: message.priceUnit ?? null,
    messagingServiceSid: message.messagingServiceSid ?? null,
    errorCode: message.errorCode ?? null,
    errorMessage: message.errorMessage ?? null,
  };
}

/** Live Twilio adapter that always delegates sender selection to a Messaging Service. */
export class TwilioSMSProvider implements SMSProvider {
  readonly name = "twilio";
  readonly live = true;

  private client: TwilioMessageClient | undefined;
  private readonly createClient: TwilioClientFactory;

  constructor(
    private readonly config: TwilioSMSProviderConfig,
    dependencies: TwilioSMSProviderDependencies = {},
  ) {
    this.createClient = dependencies.createClient ?? defaultClientFactory;
  }

  async assertReadyForLiveSend(): Promise<void> {
    if (!this.config.liveSendsEnabled) {
      throw new Error("SMS_LIVE_SENDS_ENABLED must be true for Twilio sending");
    }
    if (!this.config.productionApproved) {
      throw new Error(
        "TWILIO_PRODUCTION_APPROVED must be true for Twilio sending",
      );
    }
    assertSid(this.config.accountSid, "AC", "TWILIO_ACCOUNT_SID");
    requiredTrimmed(this.config.authToken, "TWILIO_AUTH_TOKEN");
    assertSid(
      this.config.messagingServiceSid,
      "MG",
      "TWILIO_MESSAGING_SERVICE_SID",
    );
    buildStatusCallback(this.config.appBaseUrl);
  }

  async send(input: SMSOutboundMessage): Promise<SMSSendResult> {
    await this.assertReadyForLiveSend();
    requiredTrimmed(input.idempotencyKey, "idempotencyKey");
    const to = requiredTrimmed(input.to, "to");
    if (!input.body.trim()) throw new Error("body is required");

    const request: TwilioMessageCreateRequest = {
      to,
      body: input.body,
      messagingServiceSid: this.config.messagingServiceSid.trim(),
      statusCallback: buildStatusCallback(this.config.appBaseUrl),
    };
    this.client ??= this.createClient(
      this.config.accountSid.trim(),
      this.config.authToken.trim(),
    );
    const requestFingerprint = sha256(JSON.stringify(request));
    let message: TwilioMessageResource;
    try {
      message = await this.client.messages.create(request);
    } catch (error) {
      const rejection = deterministicTwilioRejection(error);
      if (!rejection) throw error;
      return {
        status: "rejected",
        failureCode: rejection.code,
        failureReason: rejection.message,
        requestFingerprint,
        rawResponse: {
          code: rejection.code,
          httpStatus: rejection.status,
          message: rejection.message,
          ...(rejection.moreInfo ? { moreInfo: rejection.moreInfo } : {}),
        },
      };
    }
    const providerMessageId = requiredTrimmed(
      message.sid,
      "Twilio Message SID",
    );
    const from = optionalTrimmed(message.from);
    const segments = positiveInteger(message.numSegments);
    const currency = currencyCode(message.priceUnit);
    // A numeric amount without its unit must remain pending for reconciliation
    // instead of being mislabeled with the database's default currency.
    const costMicros = currency ? priceMicros(message.price) : undefined;
    const failureCode =
      message.errorCode == null ? undefined : String(message.errorCode);
    const failureReason = optionalTrimmed(message.errorMessage);

    return {
      status: normalizeTwilioMessageStatus(message.status),
      providerMessageId,
      ...(from ? { from } : {}),
      ...(segments == null ? {} : { segments }),
      ...(costMicros == null ? {} : { costMicros }),
      ...(costMicros != null && currency ? { currency } : {}),
      ...(failureCode ? { failureCode } : {}),
      ...(failureReason ? { failureReason } : {}),
      requestFingerprint,
      rawResponse: rawTwilioResponse(message),
    };
  }
}
