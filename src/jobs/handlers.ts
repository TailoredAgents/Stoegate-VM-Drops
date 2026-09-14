import { Prisma } from "@prisma/client";
import type { Job } from "pg-boss";
import { z } from "zod";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { withSmsDispatchLock } from "@/lib/sms-dispatch-lock";
import {
  ensureSmsSequenceTx,
  markSmsSuppressedBeforeSend,
  reconcileSmsOutreach,
  transitionSmsSequenceTx,
} from "@/lib/sms-outreach";
import {
  persistDryRunSmsResult,
  persistLiveSmsProviderResult,
  persistSmsDeliveryStatus,
  reserveLiveSmsAttempt,
  SmsAttemptDeferredError,
} from "@/lib/sms-operations";
import { prepareSmsMessage } from "@/lib/sms";
import {
  reconcileSynchronousSmsProviderResults,
  reconcileUnmatchedSmsStatusEvents,
} from "@/lib/sms-webhooks";
import { sha256 } from "@/lib/utils";
import { getSmsProvider } from "@/providers";
import { enqueuePrepareCampaign, enqueueSendSms } from "./queues";

const prepareSchema = z.object({
  campaignId: z.uuid(),
  mode: z.enum(["preview", "bulk"]),
});
const sendSchema = z.object({
  campaignId: z.uuid(),
  messageId: z.uuid(),
});

async function recordJobStart(
  job: Job<unknown>,
  campaignId?: string,
  entityId?: string,
) {
  await db.jobRun.upsert({
    where: { jobId: job.id },
    create: {
      jobId: job.id,
      queue: job.name,
      campaignId,
      entityId,
      status: "running",
      attempts: 1,
      startedAt: new Date(),
    },
    update: {
      status: "running",
      attempts: { increment: 1 },
      startedAt: new Date(),
      errorMessage: null,
    },
  });
}

async function recordJobFinish(job: Job<unknown>, error?: unknown) {
  await db.jobRun.updateMany({
    where: { jobId: job.id },
    data: {
      status: error ? "failed" : "completed",
      errorMessage:
        error instanceof Error ? error.message : error ? String(error) : null,
      finishedAt: new Date(),
    },
  });
}

function templateContext(cc: {
  contact: {
    firstName: string | null;
    ownerName: string | null;
  };
  property: {
    propertyAddress: string | null;
    streetName: string | null;
    city: string | null;
    state: string | null;
    county: string | null;
    acreage: Prisma.Decimal | null;
    propertyType: string | null;
  } | null;
}) {
  return {
    first_name: cc.contact.firstName,
    owner_name: cc.contact.ownerName,
    property_address: cc.property?.propertyAddress,
    street_name: cc.property?.streetName,
    city: cc.property?.city,
    state: cc.property?.state,
    county: cc.property?.county,
    acreage: cc.property?.acreage?.toString(),
    property_type: cc.property?.propertyType,
  };
}

function recordValue(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

function nonNegativeNumber(value: Prisma.JsonValue | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function campaignCost(campaign: {
  smsCostConfig: Prisma.JsonValue | null;
  smsEstimatedCostPerSegmentMicros: number;
}) {
  const config = recordValue(campaign.smsCostConfig);
  return {
    costPerSegmentCents:
      nonNegativeNumber(config.costPerSegmentMicros) / 10_000 ||
      campaign.smsEstimatedCostPerSegmentMicros / 10_000,
    fixedCostPerMessageCents:
      nonNegativeNumber(config.costPerOutboundMessageMicros) / 10_000,
  };
}

async function generatePreview(campaignId: string) {
  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { smsTemplateVersion: true },
  });
  if (
    campaign.kind !== "SMS" ||
    !["DATA_READY", "PREVIEW_READY", "APPROVED"].includes(campaign.status)
  )
    return;
  if (!campaign.smsTemplateVersion)
    throw new Error("Campaign has no SMS template version");
  await db.campaign.update({
    where: { id: campaign.id },
    data: { status: "PREVIEW_GENERATING" },
  });
  await db.campaignContact.updateMany({
    where: { campaignId: campaign.id },
    data: { isPreview: false },
  });
  const sampleSize = Math.min(
    getEnv().PREVIEW_SAMPLE_SIZE,
    campaign.eligibleCount,
  );
  const sample = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "CampaignContact"
    WHERE "campaignId" = ${campaign.id}::uuid
      AND "status" IN ('ELIGIBLE', 'PREVIEW_READY')
    ORDER BY random()
    LIMIT ${sampleSize}
  `;
  const contacts = await db.campaignContact.findMany({
    where: { id: { in: sample.map((row) => row.id) } },
    include: { contact: true, property: true },
  });
  if (!contacts.length) {
    await db.campaign.update({
      where: { id: campaign.id },
      data: { status: "FAILED" },
    });
    return;
  }
  await db.$transaction(
    contacts.map((contact) => {
      const prepared = prepareSmsMessage(
        campaign.smsTemplateVersion!.body,
        templateContext(contact),
        campaignCost(campaign),
      );
      return db.campaignContact.update({
        where: { id: contact.id },
        data: {
          isPreview: true,
          status: "PREVIEW_READY",
          renderedText: prepared.body,
          errorCode: null,
          errorMessage: null,
        },
      });
    }),
  );
  await db.campaign.update({
    where: { id: campaign.id },
    data: { status: "PREVIEW_READY" },
  });
}

async function prepareBulk(campaignId: string) {
  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { smsTemplateVersion: true },
  });
  if (
    campaign.kind !== "SMS" ||
    !["QUEUED", "SENDING"].includes(campaign.status)
  )
    return;
  if (!campaign.smsTemplateVersion)
    throw new Error("Campaign has no SMS template version");
  await db.campaign.update({
    where: { id: campaign.id },
    data: { status: "SENDING", pausedAt: null },
  });

  const alreadySelected = await db.campaignContact.count({
    where: { campaignId, selectedForSend: true },
  });
  const remaining = Math.max(0, campaign.sendLimit - alreadySelected);
  if (remaining > 0) {
    const next = await db.campaignContact.findMany({
      where: {
        campaignId,
        selectedForSend: false,
        status: { in: ["ELIGIBLE", "PREVIEW_READY"] },
      },
      orderBy: { createdAt: "asc" },
      take: remaining,
      select: { id: true },
    });
    if (next.length)
      await db.campaignContact.updateMany({
        where: { id: { in: next.map((row) => row.id) } },
        data: { selectedForSend: true },
      });
  }

  const contacts = await db.campaignContact.findMany({
    where: { campaignId, selectedForSend: true },
    include: {
      contact: true,
      property: true,
      outreachSequence: true,
      outboundMessages: { where: { sequenceNumber: 1 }, take: 1 },
      consentEvidence: {
        where: { status: "VERIFIED" },
        orderBy: { capturedAt: "desc" },
        take: 1,
      },
    },
  });
  const startAt = campaign.smsScheduledFor ?? new Date();
  for (const contact of contacts) {
    let messageId = contact.outboundMessages[0]?.id;
    if (!messageId) {
      const prepared = prepareSmsMessage(
        campaign.smsTemplateVersion.body,
        templateContext(contact),
        campaignCost(campaign),
      );
      const estimatedCostMicros = Math.round(
        (prepared.estimatedProviderCost?.estimatedProviderCostCents ?? 0) *
          10_000,
      );
      const message = await db.$transaction(async (tx) => {
        const sequence = await ensureSmsSequenceTx(
          tx,
          contact.id,
          campaign.smsColdCallDelayHours,
        );
        const conversation = await tx.smsConversation.upsert({
          where: { campaignContactId: contact.id },
          create: {
            campaignContactId: contact.id,
            providerKey: campaign.smsProviderKey ?? getEnv().SMS_PROVIDER,
          },
          update: {},
        });
        const created = await tx.smsOutboundMessage.upsert({
          where: {
            campaignContactId_sequenceNumber: {
              campaignContactId: contact.id,
              sequenceNumber: 1,
            },
          },
          create: {
            campaignContactId: contact.id,
            sequenceId: sequence.id,
            conversationId: conversation.id,
            templateVersionId: campaign.smsTemplateVersion!.id,
            consentEvidenceId: contact.consentEvidence[0]?.id,
            sequenceNumber: 1,
            idempotencyKey: `sms:${campaign.id}:${contact.id}:1`,
            toPhone: contact.contact.normalizedPhone,
            fromPhone: campaign.smsSenderRef,
            renderedBody: prepared.body,
            bodyHash: sha256(prepared.body),
            segmentCount: prepared.segments.segmentCount,
            providerKey: campaign.smsProviderKey ?? getEnv().SMS_PROVIDER,
            status: "QUEUED",
            estimatedCostMicros,
            currency: campaign.smsCurrency,
            scheduledFor: startAt,
            queuedAt: new Date(),
            complianceSnapshot: {
              campaignComplianceStatus: campaign.smsComplianceStatus,
              campaignComplianceNotes: campaign.smsComplianceNotes,
              templateVersionId: campaign.smsTemplateVersion!.id,
              templateContentHash: campaign.smsTemplateVersion!.contentHash,
              consentEvidenceId: contact.consentEvidence[0]?.id ?? null,
              timezone: campaign.smsScheduleTimezone,
              sendWindowStartMinutes: campaign.smsSendWindowStartMinutes,
              sendWindowEndMinutes: campaign.smsSendWindowEndMinutes,
            },
          },
          update: {},
        });
        await tx.campaignContact.update({
          where: { id: contact.id },
          data: {
            status: "QUEUED",
            renderedText: prepared.body,
            errorCode: null,
            errorMessage: null,
          },
        });
        await transitionSmsSequenceTx(tx, {
          sequenceId: sequence.id,
          type: "SMS_QUEUED",
          resultingState: "SMS_QUEUED",
          idempotencyKey: `sms:${created.id}:queued`,
          source: "sms_campaign_worker",
          occurredAt: created.queuedAt ?? new Date(),
          projection: {
            smsScheduledFor: startAt,
            smsToColdCallDelayHours: campaign.smsColdCallDelayHours,
            nextEligibleAt: startAt,
          },
        });
        return created;
      });
      messageId = message.id;
    }
    const existing = await db.smsOutboundMessage.findUnique({
      where: { id: messageId },
      select: { status: true, scheduledFor: true },
    });
    if (
      existing &&
      ["PENDING", "SCHEDULED", "QUEUED"].includes(existing.status)
    )
      await enqueueSendSms(
        campaign.id,
        messageId,
        existing.scheduledFor && existing.scheduledFor > new Date()
          ? existing.scheduledFor
          : undefined,
      );
  }
  if (!contacts.length) await maybeCompleteCampaign(campaign.id);
}

export async function handlePrepareCampaign(job: Job<unknown>) {
  const data = prepareSchema.parse(job.data);
  await recordJobStart(job, data.campaignId);
  try {
    if (data.mode === "preview") await generatePreview(data.campaignId);
    else await prepareBulk(data.campaignId);
    await recordJobFinish(job);
  } catch (error) {
    await recordJobFinish(job, error);
    throw error;
  }
}

async function blockedBeforeSend(messageId: string) {
  const message = await db.smsOutboundMessage.findUniqueOrThrow({
    where: { id: messageId },
    include: {
      campaignContact: {
        include: {
          contact: { include: { suppressions: { take: 1 } } },
          campaign: true,
          inboundMessages: { take: 1, select: { id: true } },
          leadAttribution: { select: { id: true } },
        },
      },
    },
  });
  const campaignSuppression = await db.campaignSuppression.findUnique({
    where: {
      campaignId_normalizedPhone: {
        campaignId: message.campaignContact.campaignId,
        normalizedPhone: message.toPhone,
      },
    },
    select: { id: true },
  });
  if (message.campaignContact.contact.suppressions.length)
    return "Globally suppressed before send";
  if (campaignSuppression) return "Suppressed for this campaign before send";
  if (message.campaignContact.inboundMessages.length)
    return "A reply already exists for this campaign contact";
  if (message.campaignContact.leadAttribution)
    return "This campaign contact is already a qualified lead";
  return null;
}

export async function handleSendSms(job: Job<unknown>) {
  const data = sendSchema.parse(job.data);
  await recordJobStart(job, data.campaignId, data.messageId);
  let liveAttemptId: string | undefined;
  try {
    const message = await db.smsOutboundMessage.findUniqueOrThrow({
      where: { id: data.messageId },
      include: { campaignContact: { include: { campaign: true } } },
    });
    const campaign = message.campaignContact.campaign;
    if (campaign.status === "PAUSED" || campaign.status === "SCHEDULED") {
      await recordJobFinish(job);
      return;
    }
    if (campaign.kind !== "SMS" || campaign.status !== "SENDING")
      throw new Error(`SMS campaign is not sendable (${campaign.status})`);
    if (!["PENDING", "SCHEDULED", "QUEUED"].includes(message.status)) {
      await recordJobFinish(job);
      return;
    }
    const blocked = await blockedBeforeSend(message.id);
    if (blocked) {
      await markSmsSuppressedBeforeSend({
        messageId: message.id,
        reason: blocked,
      });
      await maybeCompleteCampaign(campaign.id);
      await recordJobFinish(job);
      return;
    }

    const provider = getSmsProvider();
    if (provider.live) {
      await provider.assertReadyForLiveSend();
      let stopAfterDispatchLock = false;
      await withSmsDispatchLock(
        {
          campaignId: campaign.id,
          normalizedPhone: message.toPhone,
        },
        async () => {
          try {
            let reservation;
            try {
              reservation = await reserveLiveSmsAttempt({
                messageId: message.id,
                occurredAt: new Date(),
              });
            } catch (error) {
              if (error instanceof SmsAttemptDeferredError) {
                await enqueueSendSms(
                  campaign.id,
                  message.id,
                  error.nextAllowedAt,
                );
                await recordJobFinish(job);
                stopAfterDispatchLock = true;
                return;
              }
              throw error;
            }
            if (!reservation.reserved) {
              await recordJobFinish(job);
              stopAfterDispatchLock = true;
              return;
            }
            liveAttemptId = reservation.attemptId;
            const result = await provider.send({
              idempotencyKey: reservation.idempotencyKey,
              to: reservation.message.toPhone,
              from: reservation.message.fromPhone,
              body: reservation.message.renderedBody,
              clientReference: reservation.message.id,
              callbackUrl: new URL(
                "/api/webhooks/sms",
                getEnv().APP_BASE_URL,
              ).toString(),
              metadata: {
                campaignId: campaign.id,
                campaignContactId: message.campaignContactId,
              },
            });
            const providerResultAt = new Date();
            const synchronousDeliveryOutcome =
              result.status === "sent"
                ? ("SENT" as const)
                : result.status === "delivered"
                  ? ("DELIVERED" as const)
                  : result.status === "undelivered"
                    ? ("UNDELIVERED" as const)
                    : null;
            await persistLiveSmsProviderResult({
              messageId: message.id,
              attemptId: reservation.attemptId,
              providerKey: reservation.providerKey,
              outcome: [
                "accepted",
                "queued",
                "sent",
                "delivered",
                "undelivered",
              ].includes(result.status)
                ? "ACCEPTED"
                : ["rejected", "failed"].includes(result.status)
                  ? "REJECTED"
                  : "UNKNOWN",
              providerMessageId: result.providerMessageId,
              providerStatus: result.status,
              providerResponse: result.rawResponse,
              actualSegmentCount: result.segments,
              actualCostMicros: result.costMicros,
              errorCode: result.failureCode,
              errorMessage: result.failureReason,
              occurredAt: providerResultAt,
            });
            if (synchronousDeliveryOutcome) {
              if (!result.providerMessageId)
                throw new Error(
                  `Provider returned ${result.status} without a provider message ID`,
                );
              await persistSmsDeliveryStatus({
                messageId: message.id,
                providerKey: reservation.providerKey,
                providerEventId: `send-result:${reservation.attemptId}:${result.status}`,
                providerMessageId: result.providerMessageId,
                providerStatus: result.status,
                outcome: synchronousDeliveryOutcome,
                rawPayload: result.rawResponse,
                actualSegmentCount: result.segments,
                actualCostMicros: result.costMicros,
                errorCode: result.failureCode,
                errorMessage: result.failureReason,
                occurredAt: providerResultAt,
                receivedAt: providerResultAt,
              });
            }
            liveAttemptId = undefined;
          } catch (error) {
            if (liveAttemptId) {
              await persistLiveSmsProviderResult({
                messageId: data.messageId,
                attemptId: liveAttemptId,
                outcome: "UNKNOWN",
                providerStatus: "submission_unknown",
                errorCode: "PROVIDER_SUBMISSION_UNKNOWN",
                errorMessage:
                  error instanceof Error ? error.message : String(error),
                occurredAt: new Date(),
              });
              liveAttemptId = undefined;
            }
            throw error;
          }
        },
      );
      if (stopAfterDispatchLock) return;
    } else {
      const result = await provider.send({
        idempotencyKey: message.idempotencyKey,
        to: message.toPhone,
        from: message.fromPhone ?? undefined,
        body: message.renderedBody,
        clientReference: message.id,
        metadata: {
          campaignId: campaign.id,
          campaignContactId: message.campaignContactId,
        },
      });
      await persistDryRunSmsResult({
        messageId: message.id,
        providerMessageId: result.providerMessageId,
        providerResponse: result.rawResponse,
        requestFingerprint: result.requestFingerprint,
        occurredAt: new Date(),
      });
    }
    await maybeCompleteCampaign(campaign.id);
    await recordJobFinish(job);
  } catch (error) {
    if (liveAttemptId) {
      await persistLiveSmsProviderResult({
        messageId: data.messageId,
        attemptId: liveAttemptId,
        outcome: "UNKNOWN",
        providerStatus: "submission_unknown",
        errorCode: "PROVIDER_SUBMISSION_UNKNOWN",
        errorMessage: error instanceof Error ? error.message : String(error),
        occurredAt: new Date(),
      });
    }
    await recordJobFinish(job, error);
    throw error;
  }
}

export async function handleReconcileOutreach(job: Job<unknown>) {
  await recordJobStart(job);
  try {
    const now = new Date();
    await reconcileSynchronousSmsProviderResults(100);
    await reconcileUnmatchedSmsStatusEvents(100);
    const dueCampaigns = await db.campaign.findMany({
      where: {
        kind: "SMS",
        OR: [
          { status: "SCHEDULED", smsScheduledFor: { lte: now } },
          { status: "QUEUED" },
        ],
      },
      select: { id: true, status: true },
      take: 100,
    });
    for (const campaign of dueCampaigns) {
      if (campaign.status === "SCHEDULED")
        await db.campaign.updateMany({
          where: { id: campaign.id, status: "SCHEDULED" },
          data: { status: "QUEUED" },
        });
      await enqueuePrepareCampaign(campaign.id, "bulk");
    }
    const queuedMessages = await db.smsOutboundMessage.findMany({
      where: {
        status: { in: ["PENDING", "SCHEDULED", "QUEUED"] },
        scheduledFor: { lte: now },
        campaignContact: { campaign: { status: "SENDING", kind: "SMS" } },
      },
      select: { id: true, campaignContact: { select: { campaignId: true } } },
      take: 500,
    });
    for (const message of queuedMessages)
      await enqueueSendSms(message.campaignContact.campaignId, message.id);

    let examined = 0;
    do {
      const result = await reconcileSmsOutreach(now, 500);
      examined = result.examined;
    } while (examined === 500);
    await recordJobFinish(job);
  } catch (error) {
    await recordJobFinish(job, error);
    throw error;
  }
}

export async function maybeCompleteCampaign(campaignId: string) {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign || campaign.status !== "SENDING") return;
  const active = await db.smsOutboundMessage.count({
    where: {
      campaignContact: { campaignId },
      status: { in: ["PENDING", "SCHEDULED", "QUEUED", "SUBMITTING"] },
    },
  });
  if (active === 0)
    await db.campaign.update({
      where: { id: campaignId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
}
