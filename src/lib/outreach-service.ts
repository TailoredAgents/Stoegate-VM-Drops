import {
  type AttributionChannel,
  type CallbackOutcomeType,
  type ExternalOutcomeChannel,
  type OutreachChannel,
  type OutreachEventType,
  type OutreachExportType,
  type OutreachSequenceState,
  Prisma,
  type SuppressionReason,
} from "@prisma/client";
import { db } from "@/lib/db";
import { assertExternalOutcomeAllowed } from "@/lib/external-outcome-policy";
import {
  attributionForExternalChannel,
  eligibilityAt,
  isLeadOutcome,
  isTerminalOutreachState,
  resolveOutcomeState,
  stateForCallbackOutcome,
} from "@/lib/outreach-state";
import { getAppSettings } from "@/lib/settings";

type Tx = Prisma.TransactionClient;

interface EventWrite {
  type: OutreachEventType;
  channel: OutreachChannel;
  resultingState: OutreachSequenceState;
  occurredAt: Date;
  source: string;
  idempotencyKey: string;
  outcome?: string;
  externalId?: string;
  actorUserId?: string;
  rawPayload?: unknown;
  metadata?: unknown;
}

function json(value: unknown): Prisma.InputJsonValue | undefined {
  return value == null ? undefined : (value as Prisma.InputJsonValue);
}

async function lockSequenceTx(tx: Tx, sequenceId: string) {
  await tx.$queryRaw`
    SELECT "id" FROM "OutreachSequence"
    WHERE "id" = ${sequenceId}::uuid
    FOR UPDATE
  `;
  return tx.outreachSequence.findUniqueOrThrow({ where: { id: sequenceId } });
}

async function appendEventTx(
  tx: Tx,
  sequenceId: string,
  event: EventWrite,
  projection: Prisma.OutreachSequenceUncheckedUpdateInput,
) {
  const duplicate = await tx.outreachEvent.findUnique({
    where: { idempotencyKey: event.idempotencyKey },
  });
  if (duplicate) {
    if (
      duplicate.sequenceId !== sequenceId ||
      duplicate.type !== event.type ||
      duplicate.channel !== event.channel ||
      duplicate.resultingState !== event.resultingState ||
      (duplicate.outcome ?? null) !== (event.outcome ?? null)
    ) {
      throw new Error("Outreach idempotency key was reused for another event");
    }
    return { event: duplicate, duplicate: true };
  }
  const created = await tx.outreachEvent.create({
    data: {
      sequenceId,
      type: event.type,
      channel: event.channel,
      resultingState: event.resultingState,
      occurredAt: event.occurredAt,
      source: event.source,
      idempotencyKey: event.idempotencyKey,
      outcome: event.outcome,
      externalId: event.externalId,
      actorUserId: event.actorUserId,
      rawPayload: json(event.rawPayload),
      metadata: json(event.metadata),
    },
  });
  await tx.outreachSequence.update({
    where: { id: sequenceId },
    data: {
      ...projection,
      currentState: event.resultingState,
      lastEventAt: event.occurredAt,
      version: { increment: 1 },
    },
  });
  return { event: created, duplicate: false };
}

export async function ensureOutreachSequenceTx(
  tx: Tx,
  campaignContactId: string,
  occurredAt = new Date(),
) {
  return tx.outreachSequence.upsert({
    where: { campaignContactId },
    create: {
      campaignContactId,
      lastEventAt: occurredAt,
      events: {
        create: {
          type: "RVM_PENDING",
          channel: "RVM",
          resultingState: "RVM_PENDING",
          occurredAt,
          source: "campaign",
          idempotencyKey: `sequence:${campaignContactId}:created`,
        },
      },
    },
    update: {},
  });
}

export async function ensureOutreachSequence(
  campaignContactId: string,
  occurredAt = new Date(),
) {
  return db.$transaction((tx) =>
    ensureOutreachSequenceTx(tx, campaignContactId, occurredAt),
  );
}

export async function markRvmScheduled(
  campaignContactIds: string[],
  scheduledFor = new Date(),
) {
  if (!campaignContactIds.length) return;
  await db.outreachSequence.updateMany({
    where: {
      campaignContactId: { in: campaignContactIds },
      rvmScheduledFor: null,
    },
    data: { rvmScheduledFor: scheduledFor },
  });
}

export async function recordRvmSentTx(
  tx: Tx,
  input: {
    campaignContactId: string;
    occurredAt: Date;
    idempotencyKey: string;
    rawPayload?: unknown;
  },
) {
  const ensured = await ensureOutreachSequenceTx(
    tx,
    input.campaignContactId,
    input.occurredAt,
  );
  const sequence = await lockSequenceTx(tx, ensured.id);
  if (isTerminalOutreachState(sequence.currentState)) return sequence;
  if (sequence.currentState !== "RVM_PENDING") return sequence;
  await appendEventTx(
    tx,
    sequence.id,
    {
      type: "RVM_SENT",
      channel: "RVM",
      resultingState: "RVM_SENT",
      occurredAt: input.occurredAt,
      source: "rvm_worker",
      idempotencyKey: input.idempotencyKey,
      rawPayload: input.rawPayload,
    },
    {
      rvmAttemptedAt: input.occurredAt,
      rvmScheduledFor: sequence.rvmScheduledFor ?? input.occurredAt,
    },
  );
  return tx.outreachSequence.findUniqueOrThrow({ where: { id: sequence.id } });
}

export async function recordRvmDeliveryTx(
  tx: Tx,
  input: {
    campaignContactId: string;
    status: "DELIVERED" | "FAILED";
    occurredAt: Date;
    idempotencyKey: string;
    rawPayload?: unknown;
  },
) {
  const ensured = await ensureOutreachSequenceTx(
    tx,
    input.campaignContactId,
    input.occurredAt,
  );
  const sequence = await lockSequenceTx(tx, ensured.id);
  const recoveringUncertainSubmission =
    input.status === "DELIVERED" &&
    sequence.currentState === "RVM_FAILED" &&
    sequence.terminalReason === "RVM_SUBMISSION_UNKNOWN";
  if (
    isTerminalOutreachState(sequence.currentState) &&
    !recoveringUncertainSubmission
  )
    return sequence;
  if (input.status === "FAILED") {
    if (
      !["RVM_PENDING", "RVM_SENT", "RVM_FAILED"].includes(sequence.currentState)
    )
      return sequence;
    await appendEventTx(
      tx,
      sequence.id,
      {
        type: "RVM_FAILED",
        channel: "RVM",
        resultingState: "RVM_FAILED",
        occurredAt: input.occurredAt,
        source: "dropcowboy_webhook",
        idempotencyKey: input.idempotencyKey,
        rawPayload: input.rawPayload,
      },
      {
        terminalAt: sequence.terminalAt ?? input.occurredAt,
        terminalReason: "RVM_FAILED",
        nextEligibleAt: null,
      },
    );
  } else {
    if (
      !["RVM_PENDING", "RVM_SENT"].includes(sequence.currentState) &&
      !recoveringUncertainSubmission
    )
      return sequence;
    const settings = await getAppSettings(tx);
    const smsEligibleAt = eligibilityAt(
      input.occurredAt,
      settings.rvm_to_sms_delay_hours,
    );
    await appendEventTx(
      tx,
      sequence.id,
      {
        type: "RVM_SUCCESS",
        channel: "RVM",
        resultingState: "SMS_NOT_YET_ELIGIBLE",
        occurredAt: input.occurredAt,
        source: "dropcowboy_webhook",
        idempotencyKey: input.idempotencyKey,
        rawPayload: input.rawPayload,
        metadata: {
          rvmToSmsDelayHours: settings.rvm_to_sms_delay_hours,
          smsEligibleAt: smsEligibleAt.toISOString(),
        },
      },
      {
        rvmSuccessfulAt: input.occurredAt,
        smsEligibleAt,
        nextEligibleAt: smsEligibleAt,
        terminalAt: null,
        terminalReason: null,
      },
    );
    if (recoveringUncertainSubmission) {
      await tx.drop.updateMany({
        where: {
          campaignContactId: input.campaignContactId,
          status: "DELIVERED",
          errorCode: "RVM_SUBMISSION_UNKNOWN",
        },
        data: {
          failedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      await tx.campaignContact.updateMany({
        where: {
          id: input.campaignContactId,
          status: "DELIVERED",
          errorCode: "RVM_SUBMISSION_UNKNOWN",
        },
        data: { errorCode: null, errorMessage: null },
      });
    }
  }
  return tx.outreachSequence.findUniqueOrThrow({ where: { id: sequence.id } });
}

export async function recordRvmSubmissionUncertainTx(
  tx: Tx,
  input: {
    campaignContactId: string;
    occurredAt: Date;
    idempotencyKey: string;
    errorMessage: string;
  },
) {
  const ensured = await ensureOutreachSequenceTx(
    tx,
    input.campaignContactId,
    input.occurredAt,
  );
  const sequence = await lockSequenceTx(tx, ensured.id);
  if (sequence.currentState !== "RVM_SENT" || sequence.terminalAt) {
    return { sequence, recorded: false };
  }
  const written = await appendEventTx(
    tx,
    sequence.id,
    {
      type: "RVM_FAILED",
      channel: "RVM",
      resultingState: "RVM_FAILED",
      occurredAt: input.occurredAt,
      source: "rvm_worker",
      idempotencyKey: input.idempotencyKey,
      outcome: "RVM_SUBMISSION_UNKNOWN",
      metadata: { errorMessage: input.errorMessage },
    },
    {
      terminalAt: input.occurredAt,
      terminalReason: "RVM_SUBMISSION_UNKNOWN",
      nextEligibleAt: null,
    },
  );
  return {
    sequence: await tx.outreachSequence.findUniqueOrThrow({
      where: { id: sequence.id },
    }),
    recorded: !written.duplicate,
  };
}

function eventChannel(channel: AttributionChannel): OutreachChannel {
  if (channel === "SMS") return "SMS";
  if (channel === "COLD_CALL") return "COLD_CALL";
  if (channel === "RVM_CALLBACK") return "RVM";
  return "SYSTEM";
}

function creditedCallbackEventType(
  channel: AttributionChannel,
  outcome: CallbackOutcomeType,
): OutreachEventType {
  if (channel === "RVM_CALLBACK" && outcome === "CALLBACK")
    return "RVM_CALLBACK";
  if (channel === "SMS" && outcome === "CALLBACK") return "SMS_REPLIED";
  if (channel === "COLD_CALL" && outcome === "CALLBACK")
    return "COLD_CALL_CONTACTED";
  return "OUTCOME_RECORDED";
}

function outcomeRank(outcome: string) {
  const normalized = outcome
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "CLOSED") return 4;
  if (normalized === "CONTRACT") return 3;
  if (normalized === "QUALIFIED" || normalized === "QUALIFIED_LEAD") return 2;
  if (normalized === "INTERESTED") return 1;
  return 0;
}

function assertCallbackAttributionStage(
  sequence: {
    smsSentAt: Date | null;
    coldCallExportedAt: Date | null;
  },
  channel: AttributionChannel,
  occurredAt: Date,
) {
  if (channel === "SMS") {
    if (!sequence.smsSentAt)
      throw new Error("SMS attribution requires a recorded external send");
    if (occurredAt < sequence.smsSentAt)
      throw new Error("SMS outcome occurred before the recorded SMS send");
  }
  if (channel === "COLD_CALL") {
    if (!sequence.coldCallExportedAt)
      throw new Error("Cold-call attribution requires a BatchDialer export");
    if (occurredAt < sequence.coldCallExportedAt)
      throw new Error("Cold-call outcome occurred before its export");
  }
}

async function recordLeadAttributionTx(
  tx: Tx,
  input: {
    campaignContactId: string;
    campaignId: string;
    creditedChannel: AttributionChannel;
    creditedEventId: string;
    qualifyingOutcome: string;
    attributedAt: Date;
  },
) {
  const existing = await tx.leadAttribution.findUnique({
    where: { campaignContactId: input.campaignContactId },
  });
  if (!existing) {
    return tx.leadAttribution.create({ data: input });
  }
  if (
    outcomeRank(input.qualifyingOutcome) >
    outcomeRank(existing.qualifyingOutcome)
  ) {
    return tx.leadAttribution.update({
      where: { id: existing.id },
      data: { qualifyingOutcome: input.qualifyingOutcome },
    });
  }
  return existing;
}

export async function applyCallbackOutcomeToSequencesTx(
  tx: Tx,
  input: {
    normalizedPhone: string;
    outcome: CallbackOutcomeType;
    attributionChannel: AttributionChannel;
    occurredAt: Date;
    idempotencyKey: string;
    creditedCampaignContactId?: string;
    rawPayload?: unknown;
    source?: string;
  },
) {
  const sequences = await tx.outreachSequence.findMany({
    where: {
      campaignContact: { contact: { normalizedPhone: input.normalizedPhone } },
    },
    include: { campaignContact: { select: { id: true, campaignId: true } } },
    orderBy: { id: "asc" },
  });
  let touched = 0;
  for (const sequence of sequences) {
    const current = await lockSequenceTx(tx, sequence.id);
    const credited =
      sequence.campaignContact.id === input.creditedCampaignContactId;
    if (isTerminalOutreachState(current.currentState) && !credited) continue;
    if (credited)
      assertCallbackAttributionStage(
        current,
        input.attributionChannel,
        input.occurredAt,
      );
    const creditedState =
      input.outcome === "CALLBACK" && input.attributionChannel === "SMS"
        ? "SMS_REPLIED"
        : input.outcome === "CALLBACK" &&
            input.attributionChannel === "COLD_CALL"
          ? "COLD_CALL_CONTACTED"
          : stateForCallbackOutcome(input.outcome);
    const proposed =
      !credited &&
      input.outcome !== "OPT_OUT" &&
      input.outcome !== "WRONG_NUMBER"
        ? "RVM_CALLBACK"
        : creditedState;
    const resultingState = resolveOutcomeState(current.currentState, proposed);
    const written = await appendEventTx(
      tx,
      sequence.id,
      {
        type: credited
          ? creditedCallbackEventType(input.attributionChannel, input.outcome)
          : "SEQUENCE_EXITED",
        channel: credited ? eventChannel(input.attributionChannel) : "SYSTEM",
        resultingState,
        occurredAt: input.occurredAt,
        source: input.source ?? "callback_result_api",
        idempotencyKey: `${input.idempotencyKey}:sequence:${sequence.id}`,
        outcome: input.outcome,
        rawPayload: input.rawPayload,
      },
      {
        terminalAt: current.terminalAt ?? input.occurredAt,
        terminalReason: resultingState,
        nextEligibleAt: null,
        ...(credited && input.attributionChannel === "SMS"
          ? { smsRespondedAt: input.occurredAt }
          : {}),
      },
    );
    touched += 1;
    if (isLeadOutcome(input.outcome) && credited) {
      await recordLeadAttributionTx(tx, {
        campaignContactId: sequence.campaignContact.id,
        campaignId: sequence.campaignContact.campaignId,
        creditedChannel: input.attributionChannel,
        creditedEventId: written.event.id,
        qualifyingOutcome: input.outcome,
        attributedAt: input.occurredAt,
      });
    }
  }
  if (input.outcome === "OPT_OUT" || input.outcome === "WRONG_NUMBER") {
    const contact = await tx.contact.findUnique({
      where: { normalizedPhone: input.normalizedPhone },
      select: { id: true },
    });
    await tx.suppressionEntry.upsert({
      where: { normalizedPhone: input.normalizedPhone },
      create: {
        normalizedPhone: input.normalizedPhone,
        contactId: contact?.id,
        reason: input.outcome,
        source: input.source ?? "callback_result_api",
      },
      update: {
        reason: input.outcome,
        source: input.source ?? "callback_result_api",
      },
    });
  }
  return touched;
}

async function exitPhoneForExternalOutcomeTx(
  tx: Tx,
  input: {
    targetSequenceId: string;
    state: OutreachSequenceState;
    channel: ExternalOutcomeChannel;
    result: string;
    occurredAt: Date;
    idempotencyKey: string;
    externalId?: string;
    actorUserId?: string;
    rawPayload?: unknown;
    lead: boolean;
    suppression: "OPT_OUT" | "WRONG_NUMBER" | null;
  },
) {
  const target = await tx.outreachSequence.findUniqueOrThrow({
    where: { id: input.targetSequenceId },
    include: {
      campaignContact: {
        include: { contact: { select: { normalizedPhone: true, id: true } } },
      },
    },
  });
  const phone = target.campaignContact.contact.normalizedPhone;
  const sequences = await tx.outreachSequence.findMany({
    where: { campaignContact: { contact: { normalizedPhone: phone } } },
    include: { campaignContact: { select: { id: true, campaignId: true } } },
    orderBy: { id: "asc" },
  });
  let targetValidated = false;
  for (const sequence of sequences) {
    const current = await lockSequenceTx(tx, sequence.id);
    const isTarget = sequence.id === target.id;
    if (isTarget) {
      assertExternalOutcomeAllowed(
        current,
        input.channel,
        input.result,
        input.occurredAt,
      );
      targetValidated = true;
    } else if (isTerminalOutreachState(current.currentState)) {
      continue;
    }
    const proposedState =
      !isTarget && !input.suppression ? "RVM_CALLBACK" : input.state;
    const resultingState = resolveOutcomeState(
      current.currentState,
      proposedState,
    );
    const written = await appendEventTx(
      tx,
      sequence.id,
      {
        type:
          isTarget && input.state === "SMS_REPLIED"
            ? "SMS_REPLIED"
            : isTarget && input.state === "COLD_CALL_CONTACTED"
              ? "COLD_CALL_CONTACTED"
              : isTarget && input.state === "COLD_CALL_NO_ANSWER"
                ? "COLD_CALL_NO_ANSWER"
                : isTarget
                  ? "OUTCOME_RECORDED"
                  : "SEQUENCE_EXITED",
        channel: input.suppression
          ? "SYSTEM"
          : isTarget
            ? input.channel
            : "SYSTEM",
        resultingState,
        occurredAt: input.occurredAt,
        source: "external_outcome_import",
        idempotencyKey: isTarget
          ? input.idempotencyKey
          : `${input.idempotencyKey}:sequence:${sequence.id}`,
        outcome: input.result,
        externalId: input.externalId,
        actorUserId: input.actorUserId,
        rawPayload: input.rawPayload,
      },
      {
        terminalAt: current.terminalAt ?? input.occurredAt,
        terminalReason: resultingState,
        nextEligibleAt: null,
        ...(input.channel === "SMS" && isTarget
          ? { smsRespondedAt: input.occurredAt }
          : {}),
      },
    );
    if (isTarget && input.lead) {
      await recordLeadAttributionTx(tx, {
        campaignContactId: sequence.campaignContact.id,
        campaignId: sequence.campaignContact.campaignId,
        creditedChannel: attributionForExternalChannel(input.channel),
        creditedEventId: written.event.id,
        qualifyingOutcome: input.result.toUpperCase(),
        attributedAt: input.occurredAt,
      });
    }
  }
  if (!targetValidated)
    throw new Error("External outcome target was not found");
  if (input.suppression) {
    await tx.suppressionEntry.upsert({
      where: { normalizedPhone: phone },
      create: {
        normalizedPhone: phone,
        contactId: target.campaignContact.contact.id,
        reason: input.suppression,
        source: "external_outcome_import",
      },
      update: {
        reason: input.suppression,
        source: "external_outcome_import",
      },
    });
  }
}

export async function recordExternalOutcomeTx(
  tx: Tx,
  input: {
    sequenceId: string;
    channel: ExternalOutcomeChannel;
    result: string;
    occurredAt: Date;
    idempotencyKey: string;
    externalId?: string;
    actorUserId?: string;
    rawPayload?: unknown;
  },
) {
  const transitionKey = `${input.idempotencyKey}:sequence:${input.sequenceId}`;
  const prior = await tx.outreachEvent.findFirst({
    where: {
      idempotencyKey: { in: [input.idempotencyKey, transitionKey] },
    },
  });
  if (prior) {
    if (
      prior.sequenceId !== input.sequenceId ||
      (prior.outcome ?? "").trim().toLowerCase() !==
        input.result.trim().toLowerCase()
    )
      throw new Error("External outcome idempotency key conflict");
    return { duplicate: true as const };
  }
  const found = await tx.outreachSequence.findUniqueOrThrow({
    where: { id: input.sequenceId },
  });
  const transition = assertExternalOutcomeAllowed(
    found,
    input.channel,
    input.result,
    input.occurredAt,
  );
  if (transition.terminal) {
    await exitPhoneForExternalOutcomeTx(tx, {
      targetSequenceId: found.id,
      state: transition.state,
      channel: input.channel,
      result: input.result,
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
      externalId: input.externalId,
      actorUserId: input.actorUserId,
      rawPayload: input.rawPayload,
      lead: transition.lead,
      suppression: transition.suppress,
    });
    return { duplicate: false as const };
  }
  const sequence = await lockSequenceTx(tx, found.id);
  const lockedTransition = assertExternalOutcomeAllowed(
    sequence,
    input.channel,
    input.result,
    input.occurredAt,
  );
  if (input.channel !== "SMS")
    throw new Error("Only terminal cold-call results are supported");
  const isSent = lockedTransition.state === "SMS_SENT_EXTERNAL";
  const settings = isSent ? await getAppSettings(tx) : null;
  const coldCallEligibleAt = isSent
    ? eligibilityAt(input.occurredAt, settings!.sms_to_cold_call_delay_hours)
    : null;
  await appendEventTx(
    tx,
    sequence.id,
    {
      type: isSent ? "SMS_SENT_EXTERNAL" : "SMS_FAILED",
      channel: "SMS",
      resultingState: lockedTransition.state,
      occurredAt: input.occurredAt,
      source: "external_outcome_import",
      idempotencyKey: input.idempotencyKey,
      outcome: input.result,
      externalId: input.externalId,
      actorUserId: input.actorUserId,
      rawPayload: input.rawPayload,
      metadata: isSent
        ? {
            smsToColdCallDelayHours: settings!.sms_to_cold_call_delay_hours,
            coldCallEligibleAt: coldCallEligibleAt!.toISOString(),
          }
        : undefined,
    },
    isSent
      ? {
          smsSentAt: input.occurredAt,
          coldCallEligibleAt,
          nextEligibleAt: coldCallEligibleAt,
        }
      : {
          smsSentAt: null,
          coldCallEligibleAt: null,
          nextEligibleAt: null,
        },
  );
  return { duplicate: false as const };
}

export async function markSequenceExportedTx(
  tx: Tx,
  input: {
    sequenceId: string;
    exportId: string;
    type: OutreachExportType;
    occurredAt: Date;
    actorUserId: string;
    intentionalRepeat: boolean;
  },
) {
  const found = await tx.outreachSequence.findUniqueOrThrow({
    where: { id: input.sequenceId },
  });
  const sequence = await lockSequenceTx(tx, found.id);
  const expected =
    input.type === "SMS_ELIGIBILITY" ? "SMS_ELIGIBLE" : "COLD_CALL_ELIGIBLE";
  const exported =
    input.type === "SMS_ELIGIBILITY" ? "SMS_EXPORTED" : "COLD_CALL_EXPORTED";
  if (
    sequence.currentState !== expected &&
    !(input.intentionalRepeat && sequence.currentState === exported)
  ) {
    throw new Error(
      `Sequence ${sequence.id} is not eligible for this export (${sequence.currentState})`,
    );
  }
  await appendEventTx(
    tx,
    sequence.id,
    {
      type:
        input.type === "SMS_ELIGIBILITY"
          ? "SMS_EXPORTED"
          : "COLD_CALL_EXPORTED",
      channel: input.type === "SMS_ELIGIBILITY" ? "SMS" : "COLD_CALL",
      resultingState: exported,
      occurredAt: input.occurredAt,
      source: "outreach_export",
      idempotencyKey: `export:${input.exportId}:sequence:${sequence.id}`,
      actorUserId: input.actorUserId,
      metadata: { intentionalRepeat: input.intentionalRepeat },
    },
    input.type === "SMS_ELIGIBILITY"
      ? { smsExportedAt: input.occurredAt }
      : { coldCallExportedAt: input.occurredAt },
  );
}

export async function reconcileDueOutreach(now = new Date(), batchSize = 500) {
  const due = await db.outreachSequence.findMany({
    where: {
      terminalAt: null,
      nextEligibleAt: { lte: now },
      currentState: {
        in: ["SMS_NOT_YET_ELIGIBLE", "SMS_SENT_EXTERNAL"],
      },
    },
    orderBy: { nextEligibleAt: "asc" },
    take: batchSize,
  });
  let smsEligible = 0;
  let coldCallEligible = 0;
  for (const sequence of due) {
    await db.$transaction(async (tx) => {
      const isSms = sequence.currentState === "SMS_NOT_YET_ELIGIBLE";
      const finalState: OutreachSequenceState = isSms
        ? "SMS_ELIGIBLE"
        : "COLD_CALL_ELIGIBLE";
      const claimed = await tx.outreachSequence.updateMany({
        where: {
          id: sequence.id,
          version: sequence.version,
          currentState: sequence.currentState,
          terminalAt: null,
          nextEligibleAt: { lte: now },
        },
        data: {
          currentState: finalState,
          nextEligibleAt: null,
          lastEventAt: sequence.nextEligibleAt!,
          version: { increment: 1 },
          ...(isSms
            ? { smsEligibleAt: sequence.nextEligibleAt }
            : { coldCallEligibleAt: sequence.nextEligibleAt }),
        },
      });
      if (claimed.count === 0) return;
      const dueKey = sequence.nextEligibleAt!.toISOString();
      await tx.outreachEvent.createMany({
        data: isSms
          ? [
              {
                sequenceId: sequence.id,
                type: "RVM_NO_RESPONSE",
                channel: "RVM",
                resultingState: "RVM_NO_RESPONSE",
                occurredAt: sequence.nextEligibleAt!,
                source: "sequence_reconciler",
                idempotencyKey: `sequence:${sequence.id}:rvm-no-response:${dueKey}`,
              },
              {
                sequenceId: sequence.id,
                type: "SMS_ELIGIBLE",
                channel: "SMS",
                resultingState: "SMS_ELIGIBLE",
                occurredAt: sequence.nextEligibleAt!,
                source: "sequence_reconciler",
                idempotencyKey: `sequence:${sequence.id}:sms-eligible:${dueKey}`,
              },
            ]
          : [
              {
                sequenceId: sequence.id,
                type: "SMS_NO_RESPONSE",
                channel: "SMS",
                resultingState: "SMS_NO_RESPONSE",
                occurredAt: sequence.nextEligibleAt!,
                source: "sequence_reconciler",
                idempotencyKey: `sequence:${sequence.id}:sms-no-response:${dueKey}`,
              },
              {
                sequenceId: sequence.id,
                type: "COLD_CALL_ELIGIBLE",
                channel: "COLD_CALL",
                resultingState: "COLD_CALL_ELIGIBLE",
                occurredAt: sequence.nextEligibleAt!,
                source: "sequence_reconciler",
                idempotencyKey: `sequence:${sequence.id}:cold-call-eligible:${dueKey}`,
              },
            ],
      });
      if (isSms) smsEligible += 1;
      else coldCallEligible += 1;
    });
  }
  return { examined: due.length, smsEligible, coldCallEligible };
}

export async function suppressPhoneAndExit(input: {
  normalizedPhone: string;
  reason: SuppressionReason;
  source: string;
  notes?: string;
  actorUserId?: string;
  occurredAt?: Date;
}) {
  const occurredAt = input.occurredAt ?? new Date();
  return db.$transaction(async (tx) => {
    const contact = await tx.contact.findUnique({
      where: { normalizedPhone: input.normalizedPhone },
      select: { id: true },
    });
    await tx.suppressionEntry.upsert({
      where: { normalizedPhone: input.normalizedPhone },
      create: {
        normalizedPhone: input.normalizedPhone,
        contactId: contact?.id,
        reason: input.reason,
        source: input.source,
        notes: input.notes,
      },
      update: {
        reason: input.reason,
        source: input.source,
        notes: input.notes,
      },
    });
    const state: OutreachSequenceState =
      input.reason === "WRONG_NUMBER" ? "WRONG_NUMBER" : "OPT_OUT";
    const sequences = await tx.outreachSequence.findMany({
      where: {
        campaignContact: {
          contact: { normalizedPhone: input.normalizedPhone },
        },
      },
      orderBy: { id: "asc" },
    });
    for (const sequence of sequences) {
      const current = await lockSequenceTx(tx, sequence.id);
      const resultingState = resolveOutcomeState(current.currentState, state);
      await appendEventTx(
        tx,
        sequence.id,
        {
          type: "SEQUENCE_EXITED",
          channel: "SYSTEM",
          resultingState,
          occurredAt,
          source: input.source,
          idempotencyKey: `suppression:${input.normalizedPhone}:${input.reason}:${sequence.id}:${occurredAt.toISOString()}`,
          actorUserId: input.actorUserId,
          outcome: input.reason,
        },
        {
          terminalAt: current.terminalAt ?? occurredAt,
          terminalReason: input.reason,
          nextEligibleAt: null,
        },
      );
    }
    return { sequenceCount: sequences.length };
  });
}
