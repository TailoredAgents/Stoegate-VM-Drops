import { createHash } from "node:crypto";

import {
  Prisma,
  type SmsAttemptStatus,
  type SmsMessageStatus,
} from "@prisma/client";

import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { normalizeUSPhone } from "@/lib/phone";
import { isProviderOptOutSignal } from "@/lib/provider-suppression";
import { getAppSettings } from "@/lib/settings";
import { lockSmsProviderReadinessSharedTx } from "@/lib/sms-dispatch-lock";
import { assertFreshTwilioReadiness } from "@/lib/twilio-readiness";
import {
  getBusinessSendWindowAvailability,
  getLocalDayBounds,
  getNextBusinessDayStart,
  localDateKey,
  localDateStorageValue,
} from "@/lib/time";

type Tx = Prisma.TransactionClient;

const RESERVABLE_MESSAGE_STATES: readonly SmsMessageStatus[] = [
  "PENDING",
  "SCHEDULED",
  "QUEUED",
];
const RESERVED_OR_LATER_MESSAGE_STATES: readonly SmsMessageStatus[] = [
  "SUBMITTING",
  "SUBMISSION_UNKNOWN",
  "ACCEPTED",
  "SENT",
  "DELIVERED",
  "UNDELIVERED",
  "FAILED",
  "REPLIED",
  "SUPPRESSED",
  "CANCELED",
];
const RESERVABLE_CONTACT_STATES = [
  "ELIGIBLE",
  "PREVIEW_READY",
  "QUEUED",
] as const;
const RESERVABLE_SEQUENCE_STATES = [
  "SMS_PENDING",
  "SMS_ELIGIBLE",
  "SMS_SCHEDULED",
  "SMS_QUEUED",
] as const;

export type SmsAttemptDeferralReason =
  | "NOT_YET_SCHEDULED"
  | "OUTSIDE_BUSINESS_SEND_WINDOW"
  | "CAMPAIGN_DAILY_CAP_REACHED"
  | "GLOBAL_DAILY_CAP_REACHED";

export class SmsAttemptDeferredError extends Error {
  constructor(
    message: string,
    readonly reason: SmsAttemptDeferralReason,
    readonly nextAllowedAt: Date,
  ) {
    super(message);
    this.name = "SmsAttemptDeferredError";
  }
}

export interface ReserveLiveSmsAttemptInput {
  messageId: string;
  /** Defaults to the environment-selected provider and is rechecked in-transaction. */
  providerKey?: string;
  /** Internal: the caller holds the shared readiness lock through submission. */
  readinessLockAlreadyHeld?: boolean;
  requestPayload?: unknown;
  occurredAt?: Date;
}

export interface ReservedLiveSmsAttempt {
  reserved: true;
  attemptId: string;
  attemptNumber: 1;
  providerKey: string;
  idempotencyKey: string;
  message: {
    id: string;
    toPhone: string;
    /** Assigned provider sender, if already known. Messaging Services choose it. */
    fromPhone: string | null;
    /** Non-secret provider sender/service reference captured on the campaign. */
    senderReference: string;
    renderedBody: string;
    segmentCount: number;
    estimatedCostMicros: number;
    currency: string;
  };
  caps: {
    campaignTotal: number;
    campaignTotalUsed: number;
    campaignDaily: number;
    campaignDailyUsed: number;
    globalDaily: number;
    globalDailyUsed: number;
    localDate: string;
    timezone: string;
    campaignLocalDate: string;
    campaignTimezone: string;
  };
}

export interface AlreadyReservedLiveSmsAttempt {
  reserved: false;
  reason: "already_reserved";
  attemptId: string | null;
  attemptStatus: SmsAttemptStatus | null;
  messageStatus: SmsMessageStatus;
}

export type LiveSmsAttemptReservation =
  ReservedLiveSmsAttempt | AlreadyReservedLiveSmsAttempt;

export type LiveSmsProviderOutcome = "ACCEPTED" | "REJECTED" | "UNKNOWN";

export interface PersistLiveSmsProviderResultInput {
  messageId: string;
  attemptId: string;
  /** Defaults to the provider persisted by the atomic reservation. */
  providerKey?: string;
  outcome: LiveSmsProviderOutcome;
  providerRequestId?: string;
  providerMessageId?: string;
  providerStatus?: string;
  providerResponse?: unknown;
  /** Alias accepted for provider adapters that already call this rawResponse. */
  rawResponse?: unknown;
  actualSegmentCount?: number;
  actualCostMicros?: number;
  /** ISO 4217 unit for actual provider cost, when supplied. */
  currency?: string;
  /** Actual originating E.164 number selected by the provider, when known. */
  fromPhone?: string;
  errorCode?: string;
  errorMessage?: string;
  occurredAt?: Date;
}

export type SmsDeliveryOutcome =
  "ACCEPTED" | "SENT" | "DELIVERED" | "UNDELIVERED" | "FAILED";

export interface PersistSmsDeliveryStatusInput {
  messageId: string;
  providerKey: string;
  providerEventId: string;
  providerMessageId: string;
  providerStatus: string;
  outcome: SmsDeliveryOutcome;
  rawPayload: unknown;
  actualSegmentCount?: number;
  actualCostMicros?: number;
  /** ISO 4217 unit for actual provider cost, when supplied. */
  currency?: string;
  /** Actual originating E.164 number supplied by the provider callback. */
  fromPhone?: string;
  errorCode?: string;
  errorMessage?: string;
  occurredAt?: Date;
  receivedAt?: Date;
}

export interface PersistDryRunSmsResultInput {
  messageId: string;
  providerKey?: string;
  providerMessageId?: string;
  providerResponse?: unknown;
  /** Alias accepted for provider adapters that already call this rawResponse. */
  rawResponse?: unknown;
  requestFingerprint?: string;
  actualSegmentCount?: number;
  occurredAt?: Date;
}

export interface SmsPersistenceResult {
  updated: boolean;
  reason: "recorded" | "already_recorded" | "monotonic_noop";
  messageStatus: SmsMessageStatus;
}

function requiredTrimmed(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalProviderPhone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeUSPhone(value);
  if (!normalized)
    throw new Error("Provider originating number must be a valid US phone");
  return normalized;
}

function optionalCurrency(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("Provider currency must be a three-letter ISO code");
  }
  return normalized;
}

function requireCostCurrencyPair(
  actualCostMicros: number | undefined,
  currency: string | undefined,
) {
  if ((actualCostMicros === undefined) !== (currency === undefined)) {
    throw new Error(
      "Provider actual cost and currency must be supplied together",
    );
  }
}

function validateOptionalCount(
  value: number | undefined,
  field: string,
  minimum: number,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
    throw new Error(`${field} must be an integer of at least ${minimum}`);
  }
}

function toInputJson(value: unknown, field: string): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === undefined) throw new Error(`${field} must be JSON-safe`);
  try {
    return JSON.parse(serialized) as Prisma.InputJsonValue;
  } catch {
    throw new Error(`${field} must be JSON-safe`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function minutesToTime(minutes: number): string {
  const safe = Math.max(0, Math.min(1439, Math.trunc(minutes)));
  return `${Math.floor(safe / 60)
    .toString()
    .padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

function addHours(instant: Date, hours: number): Date {
  return new Date(instant.getTime() + Math.max(0, hours) * 60 * 60 * 1000);
}

function latestDate(values: Array<Date | null | undefined>): Date | null {
  const present = values.filter(
    (value): value is Date => value instanceof Date,
  );
  if (present.length === 0) return null;
  return new Date(Math.max(...present.map((value) => value.getTime())));
}

async function withSerializableRetry<T>(
  operation: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        attempt < 4 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not complete the SMS transaction safely");
}

async function lockReservationGraphTx(tx: Tx, messageId: string) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`sms-message:${messageId}`}))::text AS locked
  `;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT message."id"
    FROM "SmsOutboundMessage" message
    JOIN "CampaignContact" cc ON cc."id" = message."campaignContactId"
    JOIN "Campaign" campaign ON campaign."id" = cc."campaignId"
    JOIN "Contact" contact ON contact."id" = cc."contactId"
    JOIN "OutreachSequence" sequence
      ON sequence."id" = message."sequenceId"
      AND sequence."campaignContactId" = cc."id"
    JOIN "SmsTemplateVersion" template_version ON template_version."id" = message."templateVersionId"
    JOIN "SmsTemplate" template ON template."id" = template_version."templateId"
    JOIN "User" approval_admin ON approval_admin."id" = campaign."approvedByUserId"
    JOIN "User" launch_admin ON launch_admin."id" = campaign."launchedByUserId"
    JOIN "User" template_admin ON template_admin."id" = template_version."approvedByUserId"
    WHERE message."id" = ${messageId}::uuid
    FOR UPDATE OF message, cc, campaign, contact, sequence, template_version,
      template, approval_admin, launch_admin, template_admin
  `;
  if (locked.length !== 1) {
    throw new Error(
      "Live SMS reservation does not match an approved campaign, contact, sequence, template, and admin chain",
    );
  }
}

async function lockMessageGraphTx(tx: Tx, messageId: string) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`sms-message:${messageId}`}))::text AS locked
  `;
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT message."id"
    FROM "SmsOutboundMessage" message
    JOIN "CampaignContact" cc ON cc."id" = message."campaignContactId"
    JOIN "Campaign" campaign ON campaign."id" = cc."campaignId"
    JOIN "OutreachSequence" sequence
      ON sequence."id" = message."sequenceId"
      AND sequence."campaignContactId" = cc."id"
    WHERE message."id" = ${messageId}::uuid
    FOR UPDATE OF message, cc, campaign, sequence
  `;
  if (locked.length !== 1) {
    throw new Error(
      "SMS message does not match its campaign contact and sequence",
    );
  }
}

async function lockAttemptTx(tx: Tx, attemptId: string, messageId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT attempt."id"
    FROM "SmsOutboundAttempt" attempt
    WHERE attempt."id" = ${attemptId}::uuid
      AND attempt."messageId" = ${messageId}::uuid
    FOR UPDATE OF attempt
  `;
  if (locked.length !== 1) {
    throw new Error("SMS attempt does not belong to the outbound message");
  }
}

async function lockDailyUsageKeyTx(tx: Tx, timezone: string, dateKey: string) {
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`sms-daily:${timezone}:${dateKey}`}))::text AS locked
  `;
}

async function createTransitionRecordsTx(
  tx: Tx,
  input: {
    messageId: string;
    sequenceId: string;
    campaignId: string;
    campaignContactId: string;
    eventType:
      | "SMS_SUBMISSION_STARTED"
      | "SMS_SUBMISSION_UNKNOWN"
      | "SMS_ACCEPTED"
      | "SMS_SENT"
      | "SMS_DELIVERED"
      | "SMS_UNDELIVERED"
      | "SMS_FAILED"
      | "SMS_DRY_RUN";
    resultingState:
      | "SMS_SENDING"
      | "SMS_SUBMISSION_UNKNOWN"
      | "SMS_ACCEPTED"
      | "SMS_SENT"
      | "SMS_DELIVERED"
      | "SMS_UNDELIVERED"
      | "SMS_FAILED"
      | "SMS_DRY_RUN";
    source: string;
    idempotencySuffix: string;
    occurredAt: Date;
    actorUserId?: string | null;
    before: unknown;
    after: unknown;
    metadata?: unknown;
    rawPayload?: unknown;
  },
) {
  const idempotencyKey = `sms-message:${input.messageId}:${input.idempotencySuffix}`;
  await tx.outreachEvent.create({
    data: {
      sequenceId: input.sequenceId,
      type: input.eventType,
      channel: "SMS",
      resultingState: input.resultingState,
      source: input.source,
      idempotencyKey,
      actorUserId: input.actorUserId ?? null,
      occurredAt: input.occurredAt,
      rawPayload:
        input.rawPayload === undefined
          ? undefined
          : toInputJson(input.rawPayload, "rawPayload"),
      metadata:
        input.metadata === undefined
          ? undefined
          : toInputJson(input.metadata, "metadata"),
    },
  });
  await tx.smsAuditEvent.create({
    data: {
      eventType: input.eventType,
      entityType: "SmsOutboundMessage",
      entityId: input.messageId,
      campaignId: input.campaignId,
      campaignContactId: input.campaignContactId,
      actorUserId: input.actorUserId ?? null,
      idempotencyKey,
      source: input.source,
      before: toInputJson(input.before, "before"),
      after: toInputJson(input.after, "after"),
      metadata:
        input.metadata === undefined
          ? undefined
          : toInputJson(input.metadata, "metadata"),
      occurredAt: input.occurredAt,
    },
  });
}

async function createStatusAuditTx(
  tx: Tx,
  input: {
    messageId: string;
    campaignId: string;
    campaignContactId: string;
    providerKey: string;
    providerEventId: string;
    eventType: string;
    source: string;
    occurredAt: Date;
    before: unknown;
    after: unknown;
    metadata: unknown;
  },
) {
  await tx.smsAuditEvent.create({
    data: {
      eventType: input.eventType,
      entityType: "SmsOutboundMessage",
      entityId: input.messageId,
      campaignId: input.campaignId,
      campaignContactId: input.campaignContactId,
      idempotencyKey: `sms-status:${input.providerKey}:${input.providerEventId}`,
      source: input.source,
      before: toInputJson(input.before, "before"),
      after: toInputJson(input.after, "after"),
      metadata: toInputJson(input.metadata, "metadata"),
      occurredAt: input.occurredAt,
    },
  });
}

async function recordUsageTx(
  tx: Tx,
  input: {
    messageId: string;
    kind: "ACCEPTED" | "DELIVERED";
    occurredAt: Date;
    timezone: string;
    globalDailyCap: number;
  },
) {
  const localDate = localDateStorageValue(input.occurredAt, input.timezone);
  const dateKey = localDateKey(input.occurredAt, input.timezone);
  await lockDailyUsageKeyTx(tx, input.timezone, dateKey);
  const daily = await tx.smsDailyUsage.upsert({
    where: {
      localDate_timezone: { localDate, timezone: input.timezone },
    },
    create: {
      localDate,
      timezone: input.timezone,
      cap: input.globalDailyCap,
    },
    update: { cap: input.globalDailyCap },
  });
  const inserted = await tx.smsUsageLedger.createMany({
    data: [
      {
        dailyUsageId: daily.id,
        messageId: input.messageId,
        kind: input.kind,
        occurredAt: input.occurredAt,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return false;
  await tx.smsDailyUsage.update({
    where: { id: daily.id },
    data:
      input.kind === "ACCEPTED"
        ? { acceptedCount: { increment: 1 } }
        : { deliveredCount: { increment: 1 } },
  });
  return true;
}

/**
 * Atomically reserves the only automatic production submission for a message.
 * A false result is a hard instruction to the worker not to call the provider.
 */
export async function reserveLiveSmsAttempt(
  input: ReserveLiveSmsAttemptInput,
): Promise<LiveSmsAttemptReservation> {
  const occurredAt = input.occurredAt ?? new Date();
  const providerKey = requiredTrimmed(
    input.providerKey ?? getEnv().SMS_PROVIDER,
    "providerKey",
  );
  const requestPayload =
    input.requestPayload === undefined
      ? undefined
      : toInputJson(input.requestPayload, "requestPayload");
  const env = getEnv();

  return withSerializableRetry(async (tx) => {
    if (!input.readinessLockAlreadyHeld)
      await lockSmsProviderReadinessSharedTx(tx, providerKey);
    await lockReservationGraphTx(tx, input.messageId);
    const message = await tx.smsOutboundMessage.findUniqueOrThrow({
      where: { id: input.messageId },
      include: {
        campaignContact: {
          include: {
            contact: true,
            campaign: {
              include: { approvedBy: true, launchedBy: true },
            },
          },
        },
        sequence: true,
        templateVersion: {
          include: { template: true, approvedBy: true },
        },
        consentEvidence: true,
      },
    });
    const [priorAttempt, priorUsage] = await Promise.all([
      tx.smsOutboundAttempt.findUnique({
        where: {
          messageId_attemptNumber: { messageId: message.id, attemptNumber: 1 },
        },
      }),
      tx.smsUsageLedger.findUnique({
        where: { messageId_kind: { messageId: message.id, kind: "ATTEMPT" } },
      }),
    ]);
    if (
      priorAttempt ||
      priorUsage ||
      RESERVED_OR_LATER_MESSAGE_STATES.includes(message.status)
    ) {
      return {
        reserved: false,
        reason: "already_reserved",
        attemptId: priorAttempt?.id ?? null,
        attemptStatus: priorAttempt?.status ?? null,
        messageStatus: message.status,
      };
    }

    const campaignContact = message.campaignContact;
    const campaign = campaignContact.campaign;
    const contact = campaignContact.contact;
    const sequence = message.sequence;
    const templateVersion = message.templateVersion;
    const consent = message.consentEvidence;
    const settings = await getAppSettings(tx);
    const twilioMessagingService = providerKey.toLowerCase() === "twilio";

    if (!env.SMS_LIVE_SENDS_ENABLED) {
      throw new Error("Live SMS environment guard is disabled");
    }
    if (
      providerKey.toLowerCase() === "twilio" &&
      !env.TWILIO_PRODUCTION_APPROVED
    ) {
      throw new Error(
        "Twilio production approval environment guard is disabled",
      );
    }
    if (
      providerKey.toLowerCase() === "dry-run" ||
      providerKey !== env.SMS_PROVIDER ||
      campaign.smsProviderKey !== providerKey ||
      (message.providerKey && message.providerKey !== providerKey)
    ) {
      throw new Error("SMS provider does not match the approved live provider");
    }
    if (twilioMessagingService) {
      await assertFreshTwilioReadiness({ client: tx, env, now: occurredAt });
    }
    if (
      campaign.kind !== "SMS" ||
      campaign.status !== "SENDING" ||
      campaign.smsComplianceStatus !== "APPROVED" ||
      !campaign.approvedAt ||
      !campaign.approvedByUserId ||
      !campaign.launchedAt ||
      !campaign.launchedByUserId
    ) {
      throw new Error("Campaign is not approved and actively sending live SMS");
    }
    if (
      !campaign.approvedBy?.active ||
      campaign.approvedBy.role !== "ADMIN" ||
      !campaign.launchedBy?.active ||
      campaign.launchedBy.role !== "ADMIN"
    ) {
      throw new Error(
        "Campaign approval or launch admin is no longer authorized",
      );
    }
    if (
      campaign.smsTemplateVersionId !== templateVersion.id ||
      templateVersion.status !== "APPROVED" ||
      !templateVersion.approvedAt ||
      !templateVersion.approvedByUserId ||
      !templateVersion.approvedBy?.active ||
      templateVersion.approvedBy.role !== "ADMIN" ||
      !templateVersion.template.active
    ) {
      throw new Error(
        "The selected SMS template is no longer approved and active",
      );
    }
    if (
      campaign.sendLimit < 1 ||
      campaign.sendLimit > env.MAX_LIVE_SMS_CAMPAIGN_LIMIT
    ) {
      throw new Error("Campaign total cap exceeds the live safety ceiling");
    }
    if (
      campaign.smsDailyCap < 1 ||
      campaign.smsDailyCap > env.MAX_LIVE_DAILY_SMS_LIMIT
    ) {
      throw new Error("Campaign daily cap exceeds the live safety ceiling");
    }
    if (
      !campaignContact.selectedForSend ||
      !RESERVABLE_CONTACT_STATES.includes(
        campaignContact.status as (typeof RESERVABLE_CONTACT_STATES)[number],
      )
    ) {
      throw new Error(
        "Campaign contact is not selected and queued for live SMS",
      );
    }
    if (
      !RESERVABLE_MESSAGE_STATES.includes(message.status) ||
      !message.renderedBody.trim() ||
      message.bodyHash !== sha256(message.renderedBody) ||
      message.segmentCount < 1 ||
      message.estimatedCostMicros < 0
    ) {
      throw new Error("The rendered SMS message is not ready or has changed");
    }
    if (
      !RESERVABLE_SEQUENCE_STATES.includes(
        sequence.currentState as (typeof RESERVABLE_SEQUENCE_STATES)[number],
      ) ||
      sequence.campaignContactId !== campaignContact.id ||
      sequence.terminalAt
    ) {
      throw new Error(
        `Outreach sequence blocks SMS submission (${sequence.currentState})`,
      );
    }
    if (
      normalizeUSPhone(contact.normalizedPhone) !== contact.normalizedPhone ||
      message.toPhone !== contact.normalizedPhone
    ) {
      throw new Error(
        "Destination is not the contact's normalized US E.164 number",
      );
    }
    const senderReference = campaign.smsSenderRef;
    const originatingPhone = twilioMessagingService
      ? message.fromPhone
      : (message.fromPhone ?? senderReference);
    if (twilioMessagingService) {
      if (
        !env.TWILIO_MESSAGING_SERVICE_SID ||
        senderReference !== env.TWILIO_MESSAGING_SERVICE_SID ||
        !/^MG[0-9a-f]{32}$/i.test(senderReference)
      ) {
        throw new Error(
          "Campaign Messaging Service does not match the approved Twilio configuration",
        );
      }
      if (
        originatingPhone !== null &&
        normalizeUSPhone(originatingPhone) !== originatingPhone
      ) {
        throw new Error("The provider-assigned Twilio sender is invalid");
      }
    } else if (
      !senderReference ||
      !originatingPhone ||
      normalizeUSPhone(originatingPhone) !== originatingPhone ||
      (message.fromPhone !== null && message.fromPhone !== senderReference)
    ) {
      throw new Error(
        "A single normalized originating SMS phone number must be configured",
      );
    }
    const validatedSenderReference = requiredTrimmed(
      senderReference ?? "",
      "campaign sender reference",
    );
    if (
      !consent ||
      consent.contactId !== contact.id ||
      consent.normalizedPhone !== contact.normalizedPhone ||
      consent.status !== "VERIFIED" ||
      consent.revokedAt ||
      consent.capturedAt > occurredAt ||
      (consent.expiresAt && consent.expiresAt <= occurredAt) ||
      (consent.campaignId && consent.campaignId !== campaign.id) ||
      (consent.campaignContactId &&
        consent.campaignContactId !== campaignContact.id)
    ) {
      throw new Error("Current verified SMS consent evidence is required");
    }

    const timezone = campaign.smsScheduleTimezone;
    const windowStart =
      campaign.smsSendWindowStartMinutes === null
        ? settings.sms_send_window_start
        : minutesToTime(campaign.smsSendWindowStartMinutes);
    const windowEnd =
      campaign.smsSendWindowEndMinutes === null
        ? settings.sms_send_window_end
        : minutesToTime(campaign.smsSendWindowEndMinutes);
    const scheduledFor = latestDate([
      campaign.smsScheduledFor,
      message.scheduledFor,
      sequence.smsScheduledFor,
    ]);
    if (scheduledFor && scheduledFor > occurredAt) {
      const scheduledWindow = getBusinessSendWindowAvailability(
        scheduledFor,
        timezone,
        windowStart,
        windowEnd,
      );
      throw new SmsAttemptDeferredError(
        "SMS is not scheduled to send yet",
        "NOT_YET_SCHEDULED",
        scheduledWindow.allowed ? scheduledFor : scheduledWindow.nextAllowedAt,
      );
    }
    const window = getBusinessSendWindowAvailability(
      occurredAt,
      timezone,
      windowStart,
      windowEnd,
    );
    if (!window.allowed) {
      throw new SmsAttemptDeferredError(
        "Outside the campaign's business-day SMS send window",
        "OUTSIDE_BUSINESS_SEND_WINDOW",
        window.nextAllowedAt,
      );
    }

    const [selectedCount, globalSuppression, campaignSuppression, knownLead] =
      await Promise.all([
        tx.campaignContact.count({
          where: { campaignId: campaign.id, selectedForSend: true },
        }),
        tx.suppressionEntry.findUnique({
          where: { normalizedPhone: contact.normalizedPhone },
          select: { id: true },
        }),
        tx.campaignSuppression.findUnique({
          where: {
            campaignId_normalizedPhone: {
              campaignId: campaign.id,
              normalizedPhone: contact.normalizedPhone,
            },
          },
          select: { id: true },
        }),
        tx.leadAttribution.findFirst({
          where: { campaignContact: { contactId: contact.id } },
          select: { id: true },
        }),
      ]);
    if (selectedCount > campaign.sendLimit) {
      throw new Error("Selected contacts exceed the campaign total cap");
    }
    if (globalSuppression || campaignSuppression) {
      throw new Error("Destination became suppressed before SMS submission");
    }
    if (knownLead) {
      throw new Error("Destination is already associated with a known lead");
    }

    const globalDailyCap = Math.min(
      Math.trunc(settings.daily_sms_cap),
      env.MAX_LIVE_DAILY_SMS_LIMIT,
    );
    const globalTimezone = settings.operations_timezone;
    const localDate = localDateStorageValue(occurredAt, globalTimezone);
    const dateKey = localDateKey(occurredAt, globalTimezone);
    const campaignDay = getLocalDayBounds(occurredAt, timezone);
    await lockDailyUsageKeyTx(tx, globalTimezone, dateKey);
    const daily = await tx.smsDailyUsage.upsert({
      where: {
        localDate_timezone: { localDate, timezone: globalTimezone },
      },
      create: { localDate, timezone: globalTimezone, cap: globalDailyCap },
      update: { cap: globalDailyCap },
    });
    const [campaignTotalUsed, campaignDailyUsed] = await Promise.all([
      tx.smsUsageLedger.count({
        where: {
          kind: "ATTEMPT",
          message: { campaignContact: { campaignId: campaign.id } },
        },
      }),
      tx.smsUsageLedger.count({
        where: {
          kind: "ATTEMPT",
          occurredAt: { gte: campaignDay.start, lt: campaignDay.end },
          message: { campaignContact: { campaignId: campaign.id } },
        },
      }),
    ]);
    if (campaignTotalUsed >= campaign.sendLimit) {
      throw new Error(
        `Campaign total SMS cap of ${campaign.sendLimit} is reached`,
      );
    }
    if (campaignDailyUsed >= campaign.smsDailyCap) {
      throw new SmsAttemptDeferredError(
        `Campaign daily SMS cap of ${campaign.smsDailyCap} is reached`,
        "CAMPAIGN_DAILY_CAP_REACHED",
        getNextBusinessDayStart(occurredAt, timezone, windowStart),
      );
    }
    const capacity = await tx.smsDailyUsage.updateMany({
      where: { id: daily.id, attemptedCount: { lt: globalDailyCap } },
      data: { attemptedCount: { increment: 1 }, cap: globalDailyCap },
    });
    if (capacity.count === 0) {
      const globalReset = getNextBusinessDayStart(
        occurredAt,
        globalTimezone,
        "00:00",
      );
      const campaignWindowAtReset = getBusinessSendWindowAvailability(
        globalReset,
        timezone,
        windowStart,
        windowEnd,
      );
      throw new SmsAttemptDeferredError(
        `Global daily SMS cap of ${globalDailyCap} is reached`,
        "GLOBAL_DAILY_CAP_REACHED",
        campaignWindowAtReset.allowed
          ? globalReset
          : campaignWindowAtReset.nextAllowedAt,
      );
    }

    const attemptNumber = 1 as const;
    const attemptIdempotencyKey = `sms-message:${message.id}:attempt:1`;
    const attempt = await tx.smsOutboundAttempt.create({
      data: {
        messageId: message.id,
        attemptNumber,
        idempotencyKey: attemptIdempotencyKey,
        providerKey,
        status: "STARTED",
        requestPayload:
          requestPayload ??
          toInputJson(
            {
              to: message.toPhone,
              ...(twilioMessagingService
                ? { messagingServiceSid: validatedSenderReference }
                : { from: originatingPhone }),
              bodyHash: message.bodyHash,
              segmentCount: message.segmentCount,
            },
            "requestPayload",
          ),
        startedAt: occurredAt,
      },
    });
    await tx.smsUsageLedger.create({
      data: {
        dailyUsageId: daily.id,
        messageId: message.id,
        kind: "ATTEMPT",
        occurredAt,
      },
    });

    const complianceSnapshot = toInputJson(
      {
        checkedAt: occurredAt.toISOString(),
        campaignComplianceStatus: campaign.smsComplianceStatus,
        campaignApprovedAt: campaign.approvedAt.toISOString(),
        campaignLaunchedAt: campaign.launchedAt.toISOString(),
        templateVersionId: templateVersion.id,
        templateApprovedAt: templateVersion.approvedAt.toISOString(),
        consentEvidenceId: consent.id,
        consentBasis: consent.basis,
        consentCapturedAt: consent.capturedAt.toISOString(),
        suppressionChecks: { global: false, campaign: false },
        knownLead: false,
      },
      "complianceSnapshot",
    );
    const messageUpdated = await tx.smsOutboundMessage.updateMany({
      where: { id: message.id, status: { in: [...RESERVABLE_MESSAGE_STATES] } },
      data: {
        providerKey,
        fromPhone: originatingPhone ?? undefined,
        status: "SUBMITTING",
        submissionStartedAt: occurredAt,
        suppressionCheckedAt: occurredAt,
        complianceSnapshot,
        errorCode: null,
        errorMessage: null,
      },
    });
    const contactUpdated = await tx.campaignContact.updateMany({
      where: {
        id: campaignContact.id,
        selectedForSend: true,
        status: { in: [...RESERVABLE_CONTACT_STATES] },
      },
      data: { status: "SENDING", errorCode: null, errorMessage: null },
    });
    const sequenceUpdated = await tx.outreachSequence.updateMany({
      where: {
        id: sequence.id,
        terminalAt: null,
        currentState: { in: [...RESERVABLE_SEQUENCE_STATES] },
      },
      data: {
        currentState: "SMS_SENDING",
        version: { increment: 1 },
        nextEligibleAt: null,
        lastEventAt: occurredAt,
      },
    });
    if (
      messageUpdated.count !== 1 ||
      contactUpdated.count !== 1 ||
      sequenceUpdated.count !== 1
    ) {
      throw new Error("SMS submission state changed during reservation");
    }
    await createTransitionRecordsTx(tx, {
      messageId: message.id,
      sequenceId: sequence.id,
      campaignId: campaign.id,
      campaignContactId: campaignContact.id,
      eventType: "SMS_SUBMISSION_STARTED",
      resultingState: "SMS_SENDING",
      source: "sms-live-worker",
      idempotencySuffix: "submission-started",
      occurredAt,
      actorUserId: campaign.launchedByUserId,
      before: {
        messageStatus: message.status,
        campaignContactStatus: campaignContact.status,
        sequenceState: sequence.currentState,
      },
      after: {
        messageStatus: "SUBMITTING",
        campaignContactStatus: "SENDING",
        sequenceState: "SMS_SENDING",
        attemptId: attempt.id,
      },
      metadata: {
        providerKey,
        senderReference: validatedSenderReference,
        attemptNumber,
        campaignTotalUsed: campaignTotalUsed + 1,
        campaignDailyUsed: campaignDailyUsed + 1,
        globalDailyUsed: daily.attemptedCount + 1,
        timezone: globalTimezone,
        localDate: dateKey,
        campaignTimezone: timezone,
        campaignLocalDate: campaignDay.key,
      },
    });

    return {
      reserved: true,
      attemptId: attempt.id,
      attemptNumber,
      providerKey,
      idempotencyKey: attemptIdempotencyKey,
      message: {
        id: message.id,
        toPhone: message.toPhone,
        fromPhone: originatingPhone,
        senderReference: validatedSenderReference,
        renderedBody: message.renderedBody,
        segmentCount: message.segmentCount,
        estimatedCostMicros: message.estimatedCostMicros,
        currency: message.currency,
      },
      caps: {
        campaignTotal: campaign.sendLimit,
        campaignTotalUsed: campaignTotalUsed + 1,
        campaignDaily: campaign.smsDailyCap,
        campaignDailyUsed: campaignDailyUsed + 1,
        globalDaily: globalDailyCap,
        globalDailyUsed: daily.attemptedCount + 1,
        localDate: dateKey,
        timezone: globalTimezone,
        campaignLocalDate: campaignDay.key,
        campaignTimezone: timezone,
      },
    };
  });
}

export async function persistLiveSmsProviderResult(
  input: PersistLiveSmsProviderResultInput,
): Promise<SmsPersistenceResult> {
  const occurredAt = input.occurredAt ?? new Date();
  const rawResponse = toInputJson(
    input.providerResponse ?? input.rawResponse ?? {},
    "providerResponse",
  );
  validateOptionalCount(input.actualSegmentCount, "actualSegmentCount", 1);
  validateOptionalCount(input.actualCostMicros, "actualCostMicros", 0);
  const providerFromPhone = optionalProviderPhone(input.fromPhone);
  const providerCurrency = optionalCurrency(input.currency);
  requireCostCurrencyPair(input.actualCostMicros, providerCurrency);
  if (input.outcome === "ACCEPTED" && !input.providerMessageId?.trim()) {
    throw new Error("providerMessageId is required for an accepted SMS");
  }

  return withSerializableRetry(async (tx) => {
    await lockMessageGraphTx(tx, input.messageId);
    await lockAttemptTx(tx, input.attemptId, input.messageId);
    const [message, attempt] = await Promise.all([
      tx.smsOutboundMessage.findUniqueOrThrow({
        where: { id: input.messageId },
        include: {
          campaignContact: { include: { campaign: true } },
          sequence: true,
        },
      }),
      tx.smsOutboundAttempt.findUniqueOrThrow({
        where: { id: input.attemptId },
      }),
    ]);
    const providerKey = requiredTrimmed(
      input.providerKey ?? attempt.providerKey,
      "providerKey",
    );
    const campaign = message.campaignContact.campaign;
    const sequence = message.sequence;
    if (
      providerFromPhone &&
      message.fromPhone &&
      message.fromPhone !== providerFromPhone
    ) {
      throw new Error("Provider sender conflicts with the outbound SMS record");
    }
    if (
      attempt.messageId !== message.id ||
      attempt.attemptNumber !== 1 ||
      attempt.providerKey !== providerKey ||
      message.providerKey !== providerKey
    ) {
      throw new Error(
        "Provider result does not match the reserved SMS attempt",
      );
    }

    const targetAttemptStatus: SmsAttemptStatus =
      input.outcome === "ACCEPTED"
        ? "ACCEPTED"
        : input.outcome === "REJECTED"
          ? "FAILED"
          : "UNKNOWN";
    const targetMessageStatus: SmsMessageStatus =
      input.outcome === "ACCEPTED"
        ? "ACCEPTED"
        : input.outcome === "REJECTED"
          ? "FAILED"
          : "SUBMISSION_UNKNOWN";
    if (attempt.status !== "STARTED" || message.status !== "SUBMITTING") {
      return {
        updated: false,
        reason:
          attempt.status === targetAttemptStatus &&
          message.status === targetMessageStatus
            ? "already_recorded"
            : "monotonic_noop",
        messageStatus: message.status,
      };
    }

    const errorCode =
      input.errorCode ??
      (input.outcome === "REJECTED"
        ? "SMS_PROVIDER_REJECTED"
        : input.outcome === "UNKNOWN"
          ? "SMS_SUBMISSION_UNKNOWN"
          : null);
    const errorMessage = input.errorMessage ?? null;
    await tx.smsOutboundAttempt.update({
      where: { id: attempt.id },
      data: {
        status: targetAttemptStatus,
        providerRequestId: input.providerRequestId?.trim() || null,
        providerMessageId: input.providerMessageId?.trim() || null,
        responsePayload: rawResponse,
        errorCode,
        errorMessage,
        finishedAt: occurredAt,
      },
    });
    await tx.smsOutboundMessage.update({
      where: { id: message.id },
      data: {
        status: targetMessageStatus,
        providerMessageId: input.providerMessageId?.trim() || null,
        providerStatus: input.providerStatus?.trim() || input.outcome,
        fromPhone: providerFromPhone,
        actualSegmentCount: input.actualSegmentCount,
        actualCostMicros: input.actualCostMicros,
        ...(providerCurrency ? { currency: providerCurrency } : {}),
        acceptedAt: input.outcome === "ACCEPTED" ? occurredAt : undefined,
        failedAt: input.outcome === "REJECTED" ? occurredAt : undefined,
        errorCode,
        errorMessage,
      },
    });

    const eventType =
      input.outcome === "ACCEPTED"
        ? ("SMS_ACCEPTED" as const)
        : input.outcome === "REJECTED"
          ? ("SMS_FAILED" as const)
          : ("SMS_SUBMISSION_UNKNOWN" as const);
    const resultingState =
      input.outcome === "ACCEPTED"
        ? ("SMS_ACCEPTED" as const)
        : input.outcome === "REJECTED"
          ? ("SMS_FAILED" as const)
          : ("SMS_SUBMISSION_UNKNOWN" as const);
    const campaignContactStatus =
      input.outcome === "ACCEPTED"
        ? ("ACCEPTED" as const)
        : input.outcome === "REJECTED"
          ? ("FAILED" as const)
          : ("SENDING" as const);
    await tx.campaignContact.update({
      where: { id: message.campaignContactId },
      data: {
        status: campaignContactStatus,
        errorCode,
        errorMessage,
      },
    });
    await tx.outreachSequence.update({
      where: { id: sequence.id },
      data:
        input.outcome === "ACCEPTED"
          ? {
              currentState: resultingState,
              version: { increment: 1 },
              smsSentAt: null,
              smsToColdCallDelayHours: campaign.smsColdCallDelayHours,
              coldCallDueAt: null,
              nextEligibleAt: null,
              terminalAt: null,
              terminalReason: null,
              lastEventAt: occurredAt,
            }
          : {
              currentState: resultingState,
              version: { increment: 1 },
              coldCallDueAt: null,
              nextEligibleAt: null,
              terminalAt: occurredAt,
              terminalReason: errorCode,
              lastEventAt: occurredAt,
            },
    });

    if (input.outcome === "ACCEPTED") {
      const settings = await getAppSettings(tx);
      await recordUsageTx(tx, {
        messageId: message.id,
        kind: "ACCEPTED",
        occurredAt,
        timezone: settings.operations_timezone,
        globalDailyCap: Math.min(
          Math.trunc(settings.daily_sms_cap),
          getEnv().MAX_LIVE_DAILY_SMS_LIMIT,
        ),
      });
    }
    await createTransitionRecordsTx(tx, {
      messageId: message.id,
      sequenceId: sequence.id,
      campaignId: campaign.id,
      campaignContactId: message.campaignContactId,
      eventType,
      resultingState,
      source: "sms-provider-result",
      idempotencySuffix: `provider-result:${input.outcome.toLowerCase()}`,
      occurredAt,
      actorUserId: campaign.launchedByUserId,
      before: {
        messageStatus: message.status,
        attemptStatus: attempt.status,
        sequenceState: sequence.currentState,
      },
      after: {
        messageStatus: targetMessageStatus,
        attemptStatus: targetAttemptStatus,
        sequenceState: resultingState,
      },
      metadata: {
        providerKey,
        providerRequestId: input.providerRequestId ?? null,
        providerMessageId: input.providerMessageId ?? null,
        providerStatus: input.providerStatus ?? input.outcome,
        actualSegmentCount: input.actualSegmentCount ?? null,
        actualCostMicros: input.actualCostMicros ?? null,
        currency: providerCurrency ?? message.currency,
        fromPhone: providerFromPhone ?? message.fromPhone,
      },
      rawPayload: rawResponse,
    });
    return {
      updated: true,
      reason: "recorded",
      messageStatus: targetMessageStatus,
    };
  });
}

export async function persistSmsDeliveryStatus(
  input: PersistSmsDeliveryStatusInput,
): Promise<SmsPersistenceResult> {
  const receivedAt = input.receivedAt ?? new Date();
  const occurredAt = input.occurredAt ?? receivedAt;
  const providerKey = requiredTrimmed(input.providerKey, "providerKey");
  const providerEventId = requiredTrimmed(
    input.providerEventId,
    "providerEventId",
  );
  const providerMessageId = requiredTrimmed(
    input.providerMessageId,
    "providerMessageId",
  );
  const providerStatus = requiredTrimmed(
    input.providerStatus,
    "providerStatus",
  );
  const rawPayload = toInputJson(input.rawPayload, "rawPayload");
  validateOptionalCount(input.actualSegmentCount, "actualSegmentCount", 1);
  validateOptionalCount(input.actualCostMicros, "actualCostMicros", 0);
  const providerFromPhone = optionalProviderPhone(input.fromPhone);
  const providerCurrency = optionalCurrency(input.currency);
  requireCostCurrencyPair(input.actualCostMicros, providerCurrency);
  const providerOptOutPending = isProviderOptOutSignal(
    providerKey,
    input.errorCode,
  );

  return withSerializableRetry(async (tx) => {
    await lockMessageGraphTx(tx, input.messageId);
    const existingEvent = await tx.smsStatusEvent.findUnique({
      where: {
        providerKey_providerEventId: { providerKey, providerEventId },
      },
    });
    if (existingEvent) {
      if (
        existingEvent.messageId &&
        existingEvent.messageId !== input.messageId
      ) {
        throw new Error(
          "Provider event is already associated with another SMS",
        );
      }
      if (
        existingEvent.providerMessageId &&
        existingEvent.providerMessageId !== providerMessageId
      )
        throw new Error(
          "Provider event ID was reused for another provider message",
        );
      if (existingEvent.messageId) {
        const current = await tx.smsOutboundMessage.findUniqueOrThrow({
          where: { id: input.messageId },
          select: { status: true },
        });
        return {
          updated: false,
          reason: "already_recorded",
          messageStatus: current.status,
        };
      }
    }
    const message = await tx.smsOutboundMessage.findUniqueOrThrow({
      where: { id: input.messageId },
      include: {
        campaignContact: { include: { campaign: true } },
        sequence: true,
      },
    });
    const attempt = await tx.smsOutboundAttempt.findUnique({
      where: {
        messageId_attemptNumber: { messageId: message.id, attemptNumber: 1 },
      },
    });
    if (attempt) await lockAttemptTx(tx, attempt.id, message.id);
    if (
      message.providerKey !== providerKey ||
      (message.providerMessageId &&
        message.providerMessageId !== providerMessageId) ||
      (attempt?.providerMessageId &&
        attempt.providerMessageId !== providerMessageId)
    ) {
      throw new Error(
        "Delivery status does not match the outbound SMS provider",
      );
    }

    if (existingEvent)
      await tx.smsStatusEvent.update({
        where: { id: existingEvent.id },
        data: {
          messageId: message.id,
          providerMessageId,
          status: input.outcome,
          providerStatus,
          rawPayload,
          occurredAt,
          processedAt: providerOptOutPending ? null : receivedAt,
          processingError: null,
          errorCode: input.errorCode?.trim() || null,
          errorMessage: input.errorMessage?.trim() || null,
        },
      });
    else
      await tx.smsStatusEvent.create({
        data: {
          messageId: message.id,
          providerKey,
          providerEventId,
          providerMessageId,
          status: input.outcome,
          providerStatus,
          rawPayload,
          occurredAt,
          receivedAt,
          processedAt: providerOptOutPending ? null : receivedAt,
          errorCode: input.errorCode?.trim() || null,
          errorMessage: input.errorMessage?.trim() || null,
        },
      });

    const current = message.status;
    if (
      providerFromPhone &&
      message.fromPhone &&
      message.fromPhone !== providerFromPhone
    ) {
      throw new Error("Provider sender conflicts with the outbound SMS record");
    }
    const terminal = [
      "FAILED",
      "DELIVERED",
      "UNDELIVERED",
      "SUPPRESSED",
      "CANCELED",
      "REPLIED",
    ].includes(current);
    const mayApply =
      !terminal &&
      ((input.outcome === "ACCEPTED" &&
        ["SUBMITTING", "SUBMISSION_UNKNOWN"].includes(current)) ||
        (input.outcome === "SENT" &&
          ["SUBMITTING", "SUBMISSION_UNKNOWN", "ACCEPTED"].includes(current)) ||
        (input.outcome === "DELIVERED" &&
          ["SUBMITTING", "SUBMISSION_UNKNOWN", "ACCEPTED", "SENT"].includes(
            current,
          )) ||
        (input.outcome === "UNDELIVERED" &&
          ["SUBMITTING", "SUBMISSION_UNKNOWN", "ACCEPTED", "SENT"].includes(
            current,
          )) ||
        (input.outcome === "FAILED" &&
          ["SUBMITTING", "SUBMISSION_UNKNOWN", "ACCEPTED", "SENT"].includes(
            current,
          )));
    if (!mayApply) {
      if (providerFromPhone && !message.fromPhone) {
        await tx.smsOutboundMessage.update({
          where: { id: message.id },
          data: { fromPhone: providerFromPhone },
        });
      }
      await createStatusAuditTx(tx, {
        messageId: message.id,
        campaignId: message.campaignContact.campaign.id,
        campaignContactId: message.campaignContactId,
        providerKey,
        providerEventId,
        eventType: "SMS_STATUS_IGNORED",
        source: "sms-provider-status",
        occurredAt,
        before: { messageStatus: current },
        after: { messageStatus: current },
        metadata: {
          providerMessageId,
          providerStatus,
          normalizedStatus: input.outcome,
          reason: terminal ? "terminal_status" : "non_monotonic_status",
          rawPayload,
        },
      });
      return {
        updated: false,
        reason: "monotonic_noop",
        messageStatus: current,
      };
    }

    const campaign = message.campaignContact.campaign;
    const sequence = message.sequence;
    const isFailure = ["UNDELIVERED", "FAILED"].includes(input.outcome);
    const errorCode = isFailure
      ? (input.errorCode ??
        (input.outcome === "FAILED" ? "SMS_FAILED" : "SMS_UNDELIVERED"))
      : null;
    const errorMessage = isFailure ? (input.errorMessage ?? null) : null;
    const confirmsSend =
      input.outcome === "SENT" || input.outcome === "DELIVERED";
    const sentAt = confirmsSend
      ? (message.sentAt ?? occurredAt)
      : message.sentAt;
    const acceptedAt = message.acceptedAt ?? occurredAt;
    const coldCallAnchor = sequence.smsSentAt ?? sentAt;
    const coldCallDueAt = coldCallAnchor
      ? addHours(coldCallAnchor, campaign.smsColdCallDelayHours)
      : null;
    const effectiveColdCallDueAt = sequence.coldCallDueAt ?? coldCallDueAt;

    if (
      attempt &&
      (attempt.status === "STARTED" || attempt.status === "UNKNOWN")
    ) {
      await tx.smsOutboundAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "ACCEPTED",
          providerMessageId,
          finishedAt: attempt.finishedAt ?? occurredAt,
        },
      });
    } else if (attempt && !attempt.providerMessageId) {
      await tx.smsOutboundAttempt.update({
        where: { id: attempt.id },
        data: { providerMessageId },
      });
    }
    await tx.smsOutboundMessage.update({
      where: { id: message.id },
      data: {
        status: input.outcome,
        providerMessageId,
        providerStatus,
        fromPhone: providerFromPhone,
        actualSegmentCount: input.actualSegmentCount,
        actualCostMicros: input.actualCostMicros,
        ...(providerCurrency ? { currency: providerCurrency } : {}),
        acceptedAt,
        sentAt: confirmsSend ? sentAt : undefined,
        deliveredAt: input.outcome === "DELIVERED" ? occurredAt : undefined,
        failedAt: isFailure ? occurredAt : undefined,
        errorCode,
        errorMessage,
      },
    });
    await tx.campaignContact.update({
      where: { id: message.campaignContactId },
      data: {
        status: input.outcome,
        errorCode,
        errorMessage,
      },
    });
    await tx.outreachSequence.update({
      where: { id: sequence.id },
      data: isFailure
        ? {
            currentState:
              input.outcome === "FAILED" ? "SMS_FAILED" : "SMS_UNDELIVERED",
            version: { increment: 1 },
            coldCallDueAt: null,
            nextEligibleAt: null,
            terminalAt: occurredAt,
            terminalReason: errorCode,
            lastEventAt: occurredAt,
          }
        : input.outcome === "ACCEPTED"
          ? {
              currentState: "SMS_ACCEPTED",
              version: { increment: 1 },
              smsSentAt: null,
              coldCallDueAt: null,
              nextEligibleAt: null,
              terminalAt: null,
              terminalReason: null,
              lastEventAt: occurredAt,
            }
          : {
              currentState:
                input.outcome === "DELIVERED" ? "SMS_DELIVERED" : "SMS_SENT",
              version: { increment: 1 },
              smsSentAt: coldCallAnchor,
              smsToColdCallDelayHours: campaign.smsColdCallDelayHours,
              coldCallDueAt: effectiveColdCallDueAt,
              nextEligibleAt: effectiveColdCallDueAt,
              terminalAt: null,
              terminalReason: null,
              lastEventAt: occurredAt,
            },
    });

    const settings = await getAppSettings(tx);
    const globalDailyCap = Math.min(
      Math.trunc(settings.daily_sms_cap),
      getEnv().MAX_LIVE_DAILY_SMS_LIMIT,
    );
    await recordUsageTx(tx, {
      messageId: message.id,
      kind: "ACCEPTED",
      occurredAt,
      timezone: settings.operations_timezone,
      globalDailyCap,
    });
    if (input.outcome === "DELIVERED") {
      await recordUsageTx(tx, {
        messageId: message.id,
        kind: "DELIVERED",
        occurredAt,
        timezone: settings.operations_timezone,
        globalDailyCap,
      });
    }

    const resultingState =
      input.outcome === "DELIVERED"
        ? ("SMS_DELIVERED" as const)
        : input.outcome === "UNDELIVERED"
          ? ("SMS_UNDELIVERED" as const)
          : input.outcome === "FAILED"
            ? ("SMS_FAILED" as const)
            : input.outcome === "ACCEPTED"
              ? ("SMS_ACCEPTED" as const)
              : ("SMS_SENT" as const);
    await createTransitionRecordsTx(tx, {
      messageId: message.id,
      sequenceId: sequence.id,
      campaignId: campaign.id,
      campaignContactId: message.campaignContactId,
      eventType:
        input.outcome === "DELIVERED"
          ? "SMS_DELIVERED"
          : input.outcome === "UNDELIVERED"
            ? "SMS_UNDELIVERED"
            : input.outcome === "FAILED"
              ? "SMS_FAILED"
              : input.outcome === "ACCEPTED"
                ? "SMS_ACCEPTED"
                : "SMS_SENT",
      resultingState,
      source: "sms-provider-status",
      idempotencySuffix: `status:${providerKey}:${providerEventId}`,
      occurredAt,
      actorUserId: campaign.launchedByUserId,
      before: {
        messageStatus: current,
        sequenceState: sequence.currentState,
      },
      after: {
        messageStatus: input.outcome,
        sequenceState: resultingState,
      },
      metadata: {
        providerKey,
        providerEventId,
        providerMessageId,
        providerStatus,
        actualSegmentCount: input.actualSegmentCount ?? null,
        actualCostMicros: input.actualCostMicros ?? null,
        currency: providerCurrency ?? message.currency,
        fromPhone: providerFromPhone ?? message.fromPhone,
        errorCode,
        errorMessage,
      },
      rawPayload,
    });
    return {
      updated: true,
      reason: "recorded",
      messageStatus: input.outcome,
    };
  });
}

export async function persistDryRunSmsResult(
  input: PersistDryRunSmsResultInput,
): Promise<SmsPersistenceResult> {
  const occurredAt = input.occurredAt ?? new Date();
  const providerKey = input.providerKey?.trim() || "dry-run";
  const rawResponse = toInputJson(
    input.providerResponse ?? input.rawResponse ?? {},
    "providerResponse",
  );
  validateOptionalCount(input.actualSegmentCount, "actualSegmentCount", 1);

  return withSerializableRetry(async (tx) => {
    await lockMessageGraphTx(tx, input.messageId);
    const message = await tx.smsOutboundMessage.findUniqueOrThrow({
      where: { id: input.messageId },
      include: {
        campaignContact: { include: { campaign: true } },
        sequence: true,
      },
    });
    if (message.status === "DRY_RUN") {
      return {
        updated: false,
        reason: "already_recorded",
        messageStatus: "DRY_RUN",
      };
    }
    const [attemptCount, attemptUsage] = await Promise.all([
      tx.smsOutboundAttempt.count({ where: { messageId: message.id } }),
      tx.smsUsageLedger.findUnique({
        where: { messageId_kind: { messageId: message.id, kind: "ATTEMPT" } },
      }),
    ]);
    if (attemptCount > 0 || attemptUsage) {
      throw new Error("A dry run cannot replace a reserved live SMS attempt");
    }
    if (
      !RESERVABLE_MESSAGE_STATES.includes(message.status) ||
      !message.renderedBody.trim() ||
      message.segmentCount < 1
    ) {
      throw new Error("SMS message is not ready for a dry run");
    }

    await tx.smsOutboundMessage.update({
      where: { id: message.id },
      data: {
        providerKey,
        providerMessageId: input.providerMessageId?.trim() || null,
        providerStatus: "dry_run",
        status: "DRY_RUN",
        actualSegmentCount: input.actualSegmentCount ?? message.segmentCount,
        actualCostMicros: 0,
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.campaignContact.update({
      where: { id: message.campaignContactId },
      data: { status: "DRY_RUN", errorCode: null, errorMessage: null },
    });
    await tx.outreachSequence.update({
      where: { id: message.sequence.id },
      data: {
        currentState: "SMS_DRY_RUN",
        version: { increment: 1 },
        smsSentAt: null,
        coldCallDueAt: null,
        coldCallEligibleAt: null,
        nextEligibleAt: null,
        terminalAt: occurredAt,
        terminalReason: "SMS_DRY_RUN",
        lastEventAt: occurredAt,
      },
    });
    await createTransitionRecordsTx(tx, {
      messageId: message.id,
      sequenceId: message.sequence.id,
      campaignId: message.campaignContact.campaign.id,
      campaignContactId: message.campaignContactId,
      eventType: "SMS_DRY_RUN",
      resultingState: "SMS_DRY_RUN",
      source: "sms-dry-run",
      idempotencySuffix: "dry-run",
      occurredAt,
      before: {
        messageStatus: message.status,
        campaignContactStatus: message.campaignContact.status,
        sequenceState: message.sequence.currentState,
      },
      after: {
        messageStatus: "DRY_RUN",
        campaignContactStatus: "DRY_RUN",
        sequenceState: "SMS_DRY_RUN",
      },
      metadata: {
        providerKey,
        providerMessageId: input.providerMessageId ?? null,
        requestFingerprint: input.requestFingerprint ?? null,
        providerResponse: rawResponse,
        actualSegmentCount: input.actualSegmentCount ?? message.segmentCount,
        actualCostMicros: 0,
        liveUsageConsumed: false,
        coldCallTimerStarted: false,
      },
      rawPayload: rawResponse,
    });
    return { updated: true, reason: "recorded", messageStatus: "DRY_RUN" };
  });
}
