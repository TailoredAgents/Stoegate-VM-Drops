import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import twilio from "twilio";

import { db } from "@/lib/db";
import { normalizeUSPhone } from "@/lib/phone";
import { isProviderOptOutSignal } from "@/lib/provider-suppression";
import { withSmsPhoneDispatchLock } from "@/lib/sms-dispatch-lock";
import {
  persistSmsDeliveryStatus,
  type SmsDeliveryOutcome,
} from "@/lib/sms-operations";
import { recordSmsInboundMessage } from "@/lib/sms-conversations";
import {
  suppressPhoneGlobally,
  suppressPhoneGloballyWhileDispatchLocked,
} from "@/lib/suppression";

export const TWILIO_PROVIDER_KEY = "twilio";
export const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
export const TWILIO_WEBHOOK_LIMITS = {
  maxBodyBytes: 256 * 1024,
  maxParameters: 256,
  maxKeyBytes: 256,
  maxValueBytes: 64 * 1024,
} as const;

export type TwilioFormParams = Record<string, string | string[]>;

export class TwilioWebhookSignatureError extends Error {
  constructor() {
    super("Invalid Twilio webhook signature");
    this.name = "TwilioWebhookSignatureError";
  }
}

export class TwilioWebhookPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwilioWebhookPayloadError";
  }
}

export class TwilioWebhookPayloadTooLargeError extends Error {
  constructor() {
    super("Twilio webhook payload exceeds configured limits");
    this.name = "TwilioWebhookPayloadTooLargeError";
  }
}

export interface ValidatedTwilioWebhook {
  params: TwilioFormParams;
  publicUrl: string;
}

export interface ParsedTwilioStatus {
  providerMessageId: string;
  providerStatus: string;
  providerEventId: string;
  outcome: SmsDeliveryOutcome | null;
  recognizedStatus: boolean;
  actualSegmentCount?: number;
  fromPhone?: string;
  toPhone?: string;
  errorCode?: string;
  errorMessage?: string;
  occurredAt: Date;
  rawPayload: TwilioFormParams;
}

export interface TwilioInboundMedia {
  index: number;
  url: string;
  contentType?: string;
}

export interface ParsedTwilioInbound {
  providerMessageId: string;
  from: string;
  to: string;
  body: string;
  numMedia: number;
  media: TwilioInboundMedia[];
  optOutType?: string;
  providerOptOut: boolean;
  receivedAt: Date;
  rawPayload: TwilioFormParams;
}

const knownTwilioMessageStatuses = new Set([
  "accepted",
  "scheduled",
  "canceled",
  "queued",
  "sending",
  "sent",
  "failed",
  "delivered",
  "undelivered",
  "partially_delivered",
  "receiving",
  "received",
  "read",
]);

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function singleValue(params: TwilioFormParams, key: string, required = false) {
  const value = singleRawValue(params, key, required);
  const normalized = value?.trim();
  if (required && !normalized) {
    throw new TwilioWebhookPayloadError(
      `Twilio webhook parameter ${key} is required`,
    );
  }
  return normalized || undefined;
}

function singleRawValue(
  params: TwilioFormParams,
  key: string,
  required = false,
) {
  const value = params[key];
  if (Array.isArray(value)) {
    throw new TwilioWebhookPayloadError(
      `Twilio webhook parameter ${key} must occur once`,
    );
  }
  if (required && value === undefined) {
    throw new TwilioWebhookPayloadError(
      `Twilio webhook parameter ${key} is required`,
    );
  }
  return value;
}

function parsedInteger(
  value: string | undefined,
  field: string,
  options: { minimum: number; maximum: number },
) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new TwilioWebhookPayloadError(`${field} must be an integer`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < options.minimum ||
    parsed > options.maximum
  ) {
    throw new TwilioWebhookPayloadError(`${field} is outside the valid range`);
  }
  return parsed;
}

function assertWithinLimit(value: number, maximum: number) {
  if (value > maximum) throw new TwilioWebhookPayloadTooLargeError();
}

function formPartCount(rawBody: string) {
  if (!rawBody) return 0;
  let count = 1;
  for (let index = 0; index < rawBody.length; index += 1) {
    if (rawBody.charCodeAt(index) !== 38) continue;
    count += 1;
    assertWithinLimit(count, TWILIO_WEBHOOK_LIMITS.maxParameters);
  }
  return count;
}

async function readTwilioFormBody(request: Request) {
  const contentLength = request.headers.get("content-length")?.trim();
  if (contentLength && /^\d+$/.test(contentLength)) {
    assertWithinLimit(
      Number(contentLength),
      TWILIO_WEBHOOK_LIMITS.maxBodyBytes,
    );
  }

  if (!request.body) return "";
  const reader = request.body.getReader();
  const bytes = new Uint8Array(TWILIO_WEBHOOK_LIMITS.maxBodyBytes);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (offset + value.byteLength > TWILIO_WEBHOOK_LIMITS.maxBodyBytes) {
        await reader.cancel();
        throw new TwilioWebhookPayloadTooLargeError();
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, offset));
}

export function parseTwilioFormBody(rawBody: string): TwilioFormParams {
  assertWithinLimit(
    Buffer.byteLength(rawBody, "utf8"),
    TWILIO_WEBHOOK_LIMITS.maxBodyBytes,
  );
  formPartCount(rawBody);
  const params: TwilioFormParams = {};
  for (const [key, value] of new URLSearchParams(rawBody)) {
    assertWithinLimit(
      Buffer.byteLength(key, "utf8"),
      TWILIO_WEBHOOK_LIMITS.maxKeyBytes,
    );
    assertWithinLimit(
      Buffer.byteLength(value, "utf8"),
      TWILIO_WEBHOOK_LIMITS.maxValueBytes,
    );
    const existing = params[key];
    if (existing === undefined) params[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else params[key] = [existing, value];
  }
  return params;
}

/** Uses only the configured public host and the incoming path/query. */
export function reconstructTwilioWebhookUrl(
  appBaseUrl: string,
  incomingRequestUrl: string,
) {
  const trusted = new URL(appBaseUrl);
  const incoming = new URL(incomingRequestUrl);
  trusted.pathname = incoming.pathname;
  trusted.search = incoming.search;
  trusted.hash = "";
  return trusted.toString();
}

export async function validateTwilioWebhookRequest(input: {
  request: Request;
  appBaseUrl: string;
  authToken: string;
}): Promise<ValidatedTwilioWebhook> {
  if (!input.authToken.trim()) throw new TwilioWebhookSignatureError();
  const contentType = input.request.headers.get("content-type") ?? "";
  if (
    contentType.split(";", 1)[0].trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    throw new TwilioWebhookPayloadError(
      "Twilio webhook must be form-urlencoded",
    );
  }

  const signature = input.request.headers.get("x-twilio-signature")?.trim();
  if (!signature) throw new TwilioWebhookSignatureError();
  const params = parseTwilioFormBody(await readTwilioFormBody(input.request));
  const publicUrl = reconstructTwilioWebhookUrl(
    input.appBaseUrl,
    input.request.url,
  );
  let valid = false;
  try {
    valid = twilio.validateRequest(
      input.authToken,
      signature,
      publicUrl,
      params,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new TwilioWebhookSignatureError();
  return { params, publicUrl };
}

export function isKnownTwilioMessageStatus(status: string) {
  return knownTwilioMessageStatuses.has(status.trim().toLowerCase());
}

/** Pre-send statuses intentionally do not project to SENT. */
export function mapTwilioMessageStatus(
  status: string,
): SmsDeliveryOutcome | null {
  switch (status.trim().toLowerCase()) {
    case "accepted":
    case "queued":
    case "sending":
      return "ACCEPTED";
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "undelivered":
      return "UNDELIVERED";
    case "failed":
      return "FAILED";
    default:
      return null;
  }
}

function canonicalParams(params: TwilioFormParams) {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const value = params[key];
      return [
        key,
        Array.isArray(value) ? [...new Set(value)].sort() : value,
      ] as const;
    });
}

export function twilioStatusReplayId(params: TwilioFormParams) {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalParams(params)), "utf8")
    .digest("hex");
  return `twilio-status:${digest}`;
}

export function parseTwilioStatusWebhook(
  params: TwilioFormParams,
  receivedAt = new Date(),
): ParsedTwilioStatus {
  const providerMessageId = singleValue(params, "MessageSid", true)!;
  const messageStatus = singleValue(params, "MessageStatus");
  const smsStatus = singleValue(params, "SmsStatus");
  if (
    messageStatus &&
    smsStatus &&
    messageStatus.toLowerCase() !== smsStatus.toLowerCase()
  ) {
    throw new TwilioWebhookPayloadError(
      "Twilio MessageStatus and SmsStatus disagree",
    );
  }
  const rawStatus = messageStatus ?? smsStatus;
  if (!rawStatus) {
    throw new TwilioWebhookPayloadError(
      "Twilio webhook parameter MessageStatus is required",
    );
  }
  const providerStatus = rawStatus.toLowerCase();
  const numSegments = parsedInteger(
    singleValue(params, "NumSegments"),
    "NumSegments",
    { minimum: 0, maximum: 1_000 },
  );
  const errorCode = singleValue(params, "ErrorCode");
  const errorMessage =
    singleValue(params, "ErrorMessage") ??
    singleValue(params, "ChannelStatusMessage");
  const fromPhone = singleValue(params, "From");
  const toPhone = singleValue(params, "To");

  return {
    providerMessageId,
    providerStatus,
    providerEventId: twilioStatusReplayId(params),
    outcome: mapTwilioMessageStatus(providerStatus),
    recognizedStatus: isKnownTwilioMessageStatus(providerStatus),
    ...(numSegments && numSegments > 0
      ? { actualSegmentCount: numSegments }
      : {}),
    ...(fromPhone ? { fromPhone } : {}),
    ...(toPhone ? { toPhone } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    occurredAt: receivedAt,
    rawPayload: params,
  };
}

async function retainTwilioStatus(
  event: ParsedTwilioStatus,
  messageId: string | null,
) {
  const inserted = await db.smsStatusEvent.createMany({
    data: [
      {
        messageId,
        providerKey: TWILIO_PROVIDER_KEY,
        providerEventId: event.providerEventId,
        providerMessageId: event.providerMessageId,
        status: event.outcome,
        providerStatus: event.providerStatus,
        rawPayload: asJson(event.rawPayload),
        occurredAt: event.occurredAt,
        receivedAt: new Date(),
        processedAt:
          messageId &&
          !isProviderOptOutSignal(TWILIO_PROVIDER_KEY, event.errorCode)
            ? new Date()
            : null,
        processingError: messageId
          ? null
          : "No outbound SMS matched this Twilio MessageSid",
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      },
    ],
    skipDuplicates: true,
  });
  return inserted.count === 0;
}

async function markTwilioProviderOptOutProcessed(
  event: ParsedTwilioStatus,
  messageId: string,
) {
  await db.smsStatusEvent.updateMany({
    where: {
      providerKey: TWILIO_PROVIDER_KEY,
      providerEventId: event.providerEventId,
      messageId,
    },
    data: { processedAt: new Date(), processingError: null },
  });
}

export async function processTwilioStatusWebhook(event: ParsedTwilioStatus) {
  const message = await db.smsOutboundMessage.findFirst({
    where: {
      providerKey: TWILIO_PROVIDER_KEY,
      providerMessageId: event.providerMessageId,
    },
    select: { id: true, fromPhone: true, toPhone: true },
  });

  if (!message) {
    const duplicate = await retainTwilioStatus(event, null);
    return {
      matched: false,
      duplicate,
      applied: false,
      messageStatus: null,
      providerStatus: event.providerStatus,
      recognizedStatus: event.recognizedStatus,
    };
  }

  const processMatchedStatus = async (
    phoneDispatchLockAlreadyHeld: boolean,
  ) => {
    if (event.outcome) {
      const result = await persistSmsDeliveryStatus({
        messageId: message.id,
        providerKey: TWILIO_PROVIDER_KEY,
        providerEventId: event.providerEventId,
        providerMessageId: event.providerMessageId,
        providerStatus: event.providerStatus,
        outcome: event.outcome,
        rawPayload: event.rawPayload,
        actualSegmentCount: event.actualSegmentCount,
        fromPhone: event.fromPhone,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        occurredAt: event.occurredAt,
      });
      if (
        await applyTwilioProviderOptOut(
          event,
          message.toPhone,
          phoneDispatchLockAlreadyHeld,
        )
      ) {
        await markTwilioProviderOptOutProcessed(event, message.id);
      }
      return {
        matched: true,
        duplicate: result.reason === "already_recorded",
        applied: result.updated,
        messageStatus: result.messageStatus,
        providerStatus: event.providerStatus,
      };
    }

    if (event.fromPhone) {
      const normalizedFrom = normalizeUSPhone(event.fromPhone);
      if (
        normalizedFrom &&
        message.fromPhone &&
        message.fromPhone !== normalizedFrom
      ) {
        throw new TwilioWebhookPayloadError(
          "Twilio sender conflicts with the stored outbound message",
        );
      }
      if (normalizedFrom && !message.fromPhone) {
        await db.smsOutboundMessage.updateMany({
          where: { id: message.id, fromPhone: null },
          data: { fromPhone: normalizedFrom },
        });
      }
    }

    const duplicate = await retainTwilioStatus(event, message.id);
    if (
      await applyTwilioProviderOptOut(
        event,
        message.toPhone,
        phoneDispatchLockAlreadyHeld,
      )
    ) {
      await markTwilioProviderOptOutProcessed(event, message.id);
    }
    return {
      matched: true,
      duplicate,
      applied: false,
      messageStatus: null,
      providerStatus: event.providerStatus,
      recognizedStatus: event.recognizedStatus,
    };
  };

  const normalizedPhone = normalizeUSPhone(message.toPhone);
  if (
    normalizedPhone &&
    isProviderOptOutSignal(TWILIO_PROVIDER_KEY, event.errorCode)
  ) {
    return withSmsPhoneDispatchLock(normalizedPhone, () =>
      processMatchedStatus(true),
    );
  }
  return processMatchedStatus(false);
}

async function applyTwilioProviderOptOut(
  event: ParsedTwilioStatus,
  storedRecipient?: string,
  phoneDispatchLockAlreadyHeld = false,
) {
  if (!isProviderOptOutSignal(TWILIO_PROVIDER_KEY, event.errorCode))
    return false;
  const normalizedPhone = storedRecipient
    ? normalizeUSPhone(storedRecipient)
    : null;
  if (!normalizedPhone) return true;
  if (event.toPhone) {
    const callbackRecipient = normalizeUSPhone(event.toPhone);
    if (!callbackRecipient || callbackRecipient !== normalizedPhone)
      return true;
  }
  const suppress = phoneDispatchLockAlreadyHeld
    ? suppressPhoneGloballyWhileDispatchLocked
    : suppressPhoneGlobally;
  await suppress({
    normalizedPhone,
    reason: "PROVIDER_DNC",
    source: "twilio_provider_opt_out",
    notes: "Twilio reported that the recipient opted out of messaging.",
    occurredAt: event.occurredAt,
    idempotencyKey: `twilio-provider-opt-out:${event.providerEventId}`,
  });
  return true;
}

function validMediaUrl(value: string, field: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("Unsupported media URL protocol");
    }
    return value;
  } catch {
    throw new TwilioWebhookPayloadError(`${field} must be an HTTP(S) URL`);
  }
}

export function parseTwilioInboundWebhook(
  params: TwilioFormParams,
  receivedAt = new Date(),
): ParsedTwilioInbound {
  const providerMessageId = singleValue(params, "MessageSid", true)!;
  const from = singleValue(params, "From", true)!;
  const to = singleValue(params, "To", true)!;
  const body = singleRawValue(params, "Body") ?? "";
  if (body.length > 10_000) {
    throw new TwilioWebhookPayloadError("Twilio inbound Body is too long");
  }
  const numMedia =
    parsedInteger(singleValue(params, "NumMedia"), "NumMedia", {
      minimum: 0,
      maximum: 20,
    }) ?? 0;
  const media: TwilioInboundMedia[] = [];
  for (let index = 0; index < numMedia; index += 1) {
    const urlField = `MediaUrl${index}`;
    const url = validMediaUrl(singleValue(params, urlField, true)!, urlField);
    const contentType = singleValue(params, `MediaContentType${index}`);
    media.push({ index, url, ...(contentType ? { contentType } : {}) });
  }
  const optOutType = singleValue(params, "OptOutType")?.toUpperCase();

  return {
    providerMessageId,
    from,
    to,
    body,
    numMedia,
    media,
    ...(optOutType ? { optOutType } : {}),
    providerOptOut: optOutType === "STOP",
    receivedAt,
    rawPayload: params,
  };
}

export async function processTwilioInboundWebhook(event: ParsedTwilioInbound) {
  return recordSmsInboundMessage({
    providerKey: TWILIO_PROVIDER_KEY,
    providerMessageId: event.providerMessageId,
    from: event.from,
    to: event.to,
    body: event.body,
    receivedAt: event.receivedAt,
    providerOptOut: event.providerOptOut,
    rawPayload: {
      ...event.rawPayload,
      parsedMedia: event.media,
      optOutType: event.optOutType ?? null,
    },
  });
}

export function emptyTwimlResponse() {
  return new Response(EMPTY_TWIML, {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}
