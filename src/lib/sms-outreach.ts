import {
  type OutreachEventType,
  type OutreachSequenceState,
  Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import { lockSmsPhoneDispatchTx } from "@/lib/sms-dispatch-lock";

type Tx = Prisma.TransactionClient;

function json(value: unknown): Prisma.InputJsonValue | undefined {
  return value == null ? undefined : (value as Prisma.InputJsonValue);
}

async function lockSequence(tx: Tx, sequenceId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "OutreachSequence"
    WHERE "id" = ${sequenceId}::uuid
    FOR UPDATE
  `;
}

export async function transitionSmsSequenceTx(
  tx: Tx,
  input: {
    sequenceId: string;
    type: OutreachEventType;
    resultingState: OutreachSequenceState;
    idempotencyKey: string;
    source: string;
    occurredAt: Date;
    actorUserId?: string;
    outcome?: string;
    rawPayload?: unknown;
    metadata?: unknown;
    projection?: Prisma.OutreachSequenceUncheckedUpdateInput;
  },
) {
  await lockSequence(tx, input.sequenceId);
  const duplicate = await tx.outreachEvent.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true },
  });
  if (duplicate) return false;

  await tx.outreachEvent.create({
    data: {
      sequenceId: input.sequenceId,
      type: input.type,
      channel: "SMS",
      resultingState: input.resultingState,
      idempotencyKey: input.idempotencyKey,
      source: input.source,
      occurredAt: input.occurredAt,
      actorUserId: input.actorUserId,
      outcome: input.outcome,
      rawPayload: json(input.rawPayload),
      metadata: json(input.metadata),
    },
  });
  await tx.outreachSequence.update({
    where: { id: input.sequenceId },
    data: {
      currentState: input.resultingState,
      lastEventAt: input.occurredAt,
      version: { increment: 1 },
      ...(input.projection ?? {}),
    },
  });
  return true;
}

export async function ensureSmsSequenceTx(
  tx: Tx,
  campaignContactId: string,
  delayHours: number,
) {
  const sequence = await tx.outreachSequence.upsert({
    where: { campaignContactId },
    create: {
      campaignContactId,
      currentState: "SMS_PENDING",
      smsToColdCallDelayHours: delayHours,
    },
    update: {},
  });
  await tx.outreachEvent.createMany({
    data: [
      {
        sequenceId: sequence.id,
        type: "SMS_PENDING",
        channel: "SMS",
        resultingState: sequence.currentState,
        source: "sms_campaign",
        occurredAt: sequence.createdAt,
        idempotencyKey: `sms-sequence:${campaignContactId}:created`,
      },
    ],
    skipDuplicates: true,
  });
  return sequence;
}

export async function markSmsSuppressedBeforeSend(input: {
  messageId: string;
  reason: string;
  occurredAt?: Date;
}) {
  const occurredAt = input.occurredAt ?? new Date();
  return db.$transaction(async (tx) => {
    const message = await tx.smsOutboundMessage.findUniqueOrThrow({
      where: { id: input.messageId },
      select: {
        id: true,
        campaignContactId: true,
        sequenceId: true,
        toPhone: true,
      },
    });
    await lockSmsPhoneDispatchTx(tx, message.toPhone);
    await tx.smsOutboundMessage.updateMany({
      where: {
        id: message.id,
        status: { in: ["PENDING", "SCHEDULED", "QUEUED"] },
      },
      data: {
        status: "SUPPRESSED",
        canceledAt: occurredAt,
        errorCode: "SUPPRESSED",
        errorMessage: input.reason,
      },
    });
    await tx.campaignContact.update({
      where: { id: message.campaignContactId },
      data: {
        status: "SUPPRESSED",
        errorCode: "SUPPRESSED",
        errorMessage: input.reason,
      },
    });
    await transitionSmsSequenceTx(tx, {
      sequenceId: message.sequenceId,
      type: "SMS_SUPPRESSED",
      resultingState: "SMS_SUPPRESSED",
      idempotencyKey: `sms:${message.id}:suppressed`,
      source: "sms_send_guard",
      occurredAt,
      outcome: input.reason,
      projection: {
        terminalAt: occurredAt,
        terminalReason: input.reason,
        nextEligibleAt: null,
      },
    });
  });
}

export function coldCallDueAt(sentAt: Date, delayHours: number) {
  return new Date(sentAt.getTime() + delayHours * 60 * 60 * 1000);
}

export const COLD_CALL_CLOCK_STATES: OutreachSequenceState[] = [
  "SMS_SENT",
  "SMS_DELIVERED",
];

export async function reconcileSmsOutreach(now = new Date(), batchSize = 500) {
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const staleSubmissions = await db.smsOutboundMessage.findMany({
    where: {
      status: "SUBMITTING",
      submissionStartedAt: { lte: staleBefore },
    },
    select: { id: true, sequenceId: true, campaignContactId: true },
    take: batchSize,
  });
  for (const message of staleSubmissions) {
    await db.$transaction(async (tx) => {
      const updated = await tx.smsOutboundMessage.updateMany({
        where: { id: message.id, status: "SUBMITTING" },
        data: {
          status: "SUBMISSION_UNKNOWN",
          errorCode: "PROVIDER_SUBMISSION_UNKNOWN",
          errorMessage:
            "Worker stopped before the provider result was durably recorded; automatic retry is blocked.",
        },
      });
      if (!updated.count) return;
      await tx.smsOutboundAttempt.updateMany({
        where: { messageId: message.id, status: "STARTED" },
        data: {
          status: "UNKNOWN",
          finishedAt: now,
          errorCode: "WORKER_RESULT_MISSING",
        },
      });
      await tx.campaignContact.update({
        where: { id: message.campaignContactId },
        data: {
          status: "FAILED",
          errorCode: "PROVIDER_SUBMISSION_UNKNOWN",
        },
      });
      await transitionSmsSequenceTx(tx, {
        sequenceId: message.sequenceId,
        type: "SMS_SUBMISSION_UNKNOWN",
        resultingState: "SMS_SUBMISSION_UNKNOWN",
        idempotencyKey: `sms:${message.id}:submission-unknown:reconcile`,
        source: "sms_reconciler",
        occurredAt: now,
        projection: { nextEligibleAt: null },
      });
    });
  }

  const due = await db.outreachSequence.findMany({
    where: {
      currentState: { in: COLD_CALL_CLOCK_STATES },
      coldCallDueAt: { lte: now },
      smsRespondedAt: null,
      terminalAt: null,
    },
    select: { id: true },
    orderBy: { coldCallDueAt: "asc" },
    take: batchSize,
  });
  let eligible = 0;
  let blocked = 0;
  for (const candidate of due) {
    await db.$transaction(async (tx) => {
      await lockSequence(tx, candidate.id);
      const sequence = await tx.outreachSequence.findUniqueOrThrow({
        where: { id: candidate.id },
        include: {
          campaignContact: {
            include: {
              contact: { include: { suppressions: true } },
              campaign: true,
              inboundMessages: { select: { id: true }, take: 1 },
              leadAttribution: { select: { id: true } },
            },
          },
        },
      });
      if (
        !COLD_CALL_CLOCK_STATES.includes(sequence.currentState) ||
        !sequence.coldCallDueAt ||
        sequence.coldCallDueAt > now ||
        sequence.smsRespondedAt ||
        sequence.terminalAt
      )
        return;
      const phone = sequence.campaignContact.contact.normalizedPhone;
      const campaignSuppression = await tx.campaignSuppression.findUnique({
        where: {
          campaignId_normalizedPhone: {
            campaignId: sequence.campaignContact.campaignId,
            normalizedPhone: phone,
          },
        },
        select: { id: true },
      });
      if (
        sequence.campaignContact.inboundMessages.length ||
        sequence.campaignContact.leadAttribution ||
        sequence.campaignContact.contact.suppressions.length ||
        campaignSuppression
      ) {
        blocked += 1;
        return;
      }
      const changed = await transitionSmsSequenceTx(tx, {
        sequenceId: sequence.id,
        type: "COLD_CALL_ELIGIBLE",
        resultingState: "COLD_CALL_ELIGIBLE",
        idempotencyKey: `sms-sequence:${sequence.id}:cold-call-eligible`,
        source: "sms_reconciler",
        occurredAt: now,
        projection: {
          coldCallEligibleAt: now,
          nextEligibleAt: null,
        },
      });
      if (changed) eligible += 1;
    });
  }
  return {
    examined: due.length,
    eligible,
    blocked,
    staleSubmissions: staleSubmissions.length,
  };
}
