import { randomUUID } from "node:crypto";
import {
  type OutreachSequenceState,
  Prisma,
  type SmsInboundClassification,
  type SmsMessageStatus,
  type SuppressionReason,
} from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeUSPhone } from "@/lib/phone";
import { lockSmsPhoneDispatchTx } from "@/lib/sms-dispatch-lock";
import { isSmsOptOutText } from "@/lib/sms-replies";
import { transitionSmsSequenceTx } from "@/lib/sms-outreach";
import { sha256 } from "@/lib/utils";

type Tx = Prisma.TransactionClient;

const replyMatchStatuses: SmsMessageStatus[] = [
  "SUBMISSION_UNKNOWN",
  "ACCEPTED",
  "SENT",
  "DELIVERED",
  "REPLIED",
];

export const SMS_INBOUND_CLASSIFICATIONS = [
  "UNCLASSIFIED",
  "INTERESTED",
  "MAYBE",
  "QUALIFIED_LEAD",
  "FOLLOW_UP",
  "NOT_INTERESTED",
  "PROPERTY_SOLD",
  "AGENT",
  "HOSTILE",
  "WRONG_NUMBER",
  "OPT_OUT",
  "OTHER",
  "NEEDS_REVIEW",
] as const satisfies readonly SmsInboundClassification[];

export interface SmsInboundClassificationPolicy {
  sequenceState: OutreachSequenceState | null;
  globalSuppression: "OPT_OUT" | "WRONG_NUMBER" | null;
  createsLead: boolean;
  closesConversation: boolean;
}

const classificationPolicies = {
  UNCLASSIFIED: {
    sequenceState: null,
    globalSuppression: null,
    createsLead: false,
    closesConversation: false,
  },
  INTERESTED: {
    sequenceState: "INTERESTED",
    globalSuppression: null,
    createsLead: false,
    closesConversation: false,
  },
  MAYBE: {
    sequenceState: null,
    globalSuppression: null,
    createsLead: false,
    closesConversation: false,
  },
  QUALIFIED_LEAD: {
    sequenceState: "QUALIFIED_LEAD",
    globalSuppression: null,
    createsLead: true,
    closesConversation: false,
  },
  FOLLOW_UP: {
    sequenceState: "FOLLOW_UP",
    globalSuppression: null,
    createsLead: false,
    closesConversation: false,
  },
  NOT_INTERESTED: {
    sequenceState: "NOT_INTERESTED",
    globalSuppression: null,
    createsLead: false,
    closesConversation: true,
  },
  PROPERTY_SOLD: {
    sequenceState: null,
    globalSuppression: null,
    createsLead: false,
    closesConversation: true,
  },
  AGENT: {
    sequenceState: null,
    globalSuppression: null,
    createsLead: false,
    closesConversation: true,
  },
  HOSTILE: {
    sequenceState: null,
    globalSuppression: null,
    createsLead: false,
    closesConversation: true,
  },
  WRONG_NUMBER: {
    sequenceState: "WRONG_NUMBER",
    globalSuppression: "WRONG_NUMBER",
    createsLead: false,
    closesConversation: true,
  },
  OPT_OUT: {
    sequenceState: "OPT_OUT",
    globalSuppression: "OPT_OUT",
    createsLead: false,
    closesConversation: true,
  },
  OTHER: {
    sequenceState: null,
    globalSuppression: null,
    createsLead: false,
    closesConversation: false,
  },
  NEEDS_REVIEW: {
    sequenceState: null,
    globalSuppression: null,
    createsLead: false,
    closesConversation: false,
  },
} as const satisfies Record<
  SmsInboundClassification,
  SmsInboundClassificationPolicy
>;

export function smsInboundClassificationPolicy(
  classification: SmsInboundClassification,
): SmsInboundClassificationPolicy {
  return classificationPolicies[classification];
}

export function smsInboundProviderIdentity(
  providerKey: string,
  providerMessageId: string,
) {
  return sha256(
    `${providerKey.trim().toLowerCase()}\0${providerMessageId.trim()}`,
  );
}

export interface SmsOutboundReplyCandidate {
  providerKey: string | null;
  providerMessageId: string | null;
  toPhone: string;
  fromPhone: string | null;
  status: SmsMessageStatus;
  createdAt: Date;
  acceptedAt: Date | null;
  sentAt: Date | null;
}

export function selectMostRecentReplyCandidate<
  T extends SmsOutboundReplyCandidate,
>(
  candidates: readonly T[],
  inbound: { providerKey: string; fromPhone: string; toPhone: string },
): T | null {
  const matches = candidates
    .filter(
      (candidate) =>
        candidate.providerKey === inbound.providerKey &&
        candidate.toPhone === inbound.fromPhone &&
        candidate.fromPhone === inbound.toPhone &&
        replyMatchStatuses.includes(candidate.status),
    )
    .toSorted(
      (left, right) =>
        (right.sentAt ?? right.acceptedAt ?? right.createdAt).getTime() -
        (left.sentAt ?? left.acceptedAt ?? left.createdAt).getTime(),
    );
  const newest = matches[0];
  const runnerUp = matches[1];
  if (!newest) return null;
  if (
    runnerUp &&
    (newest.sentAt ?? newest.acceptedAt ?? newest.createdAt).getTime() ===
      (runnerUp.sentAt ?? runnerUp.acceptedAt ?? runnerUp.createdAt).getTime()
  ) {
    return null;
  }
  return newest;
}

export interface RecordSmsInboundInput {
  providerKey: string;
  providerMessageId: string;
  providerConversationId?: string;
  from: string;
  to: string;
  body: string;
  receivedAt: Date;
  providerOptOut?: boolean;
  rawPayload?: Readonly<Record<string, unknown>>;
}

export interface RecordedSmsInbound {
  messageId: string;
  conversationId: string | null;
  matchedOutboundMessageId: string | null;
  duplicate: boolean;
  classification: SmsInboundClassification;
}

function inputJson(value: Readonly<Record<string, unknown>> | undefined) {
  try {
    return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonObject;
  } catch {
    throw new Error("Inbound raw payload must be JSON serializable");
  }
}

function later(left: Date | null, right: Date) {
  return left && left > right ? left : right;
}

function normalizedInbound(input: RecordSmsInboundInput) {
  const providerKey = input.providerKey.trim().toLowerCase();
  const providerMessageId = input.providerMessageId.trim();
  const fromPhone = normalizeUSPhone(input.from);
  const toPhone = normalizeUSPhone(input.to) ?? input.to.trim();
  if (!providerKey) throw new Error("Inbound provider key is required");
  if (!providerMessageId)
    throw new Error("Inbound provider message ID is required");
  if (!fromPhone) throw new Error("Inbound sender must be a valid US phone");
  if (!toPhone) throw new Error("Inbound destination is required");
  if (typeof input.body !== "string" || input.body.length > 10_000)
    throw new Error("Inbound SMS body is invalid");
  if (
    !(input.receivedAt instanceof Date) ||
    Number.isNaN(input.receivedAt.getTime())
  )
    throw new Error("Inbound received timestamp is invalid");
  const body = input.body;
  const isOptOut = input.providerOptOut === true || isSmsOptOutText(body);
  return {
    providerKey,
    providerMessageId,
    providerConversationId: input.providerConversationId?.trim() || undefined,
    fromPhone,
    toPhone,
    body,
    receivedAt: input.receivedAt,
    isOptOut,
    optOutSource:
      providerKey === "twilio"
        ? "TWILIO_INBOUND_OPT_OUT"
        : "sms_inbound_opt_out",
    rawPayload: inputJson(input.rawPayload),
  };
}

function assertDuplicateMatches(
  existing: {
    fromPhone: string;
    toPhone: string;
    body: string;
  },
  input: ReturnType<typeof normalizedInbound>,
) {
  if (
    existing.fromPhone !== input.fromPhone ||
    existing.toPhone !== input.toPhone ||
    existing.body !== input.body
  )
    throw new Error(
      "Provider message ID was reused for conflicting inbound content",
    );
}

async function upsertCampaignSuppressionTx(
  tx: Tx,
  input: {
    campaignId: string;
    contactId: string;
    normalizedPhone: string;
    reason: SuppressionReason;
    source: string;
    actorUserId?: string;
  },
) {
  const key = {
    campaignId: input.campaignId,
    normalizedPhone: input.normalizedPhone,
  };
  const existing = await tx.campaignSuppression.findUnique({
    where: { campaignId_normalizedPhone: key },
  });
  const strongExisting =
    existing &&
    ["OPT_OUT", "PROVIDER_DNC", "WRONG_NUMBER"].includes(existing.reason);
  const reason = strongExisting ? existing.reason : input.reason;
  return tx.campaignSuppression.upsert({
    where: { campaignId_normalizedPhone: key },
    create: {
      ...key,
      contactId: input.contactId,
      reason,
      source: input.source,
      notes: "Inbound SMS response blocks further campaign outreach",
      createdByUserId: input.actorUserId,
    },
    update: {
      contactId: input.contactId,
      reason,
      source: input.source,
      notes: "Inbound SMS response blocks further campaign outreach",
    },
  });
}

async function globallySuppressPhoneTx(
  tx: Tx,
  input: {
    normalizedPhone: string;
    reason: "OPT_OUT" | "WRONG_NUMBER";
    source: string;
    occurredAt: Date;
    idempotencyBase: string;
    actorUserId?: string;
    targetSequenceId?: string;
  },
) {
  await lockSmsPhoneDispatchTx(tx, input.normalizedPhone);
  const contact = await tx.contact.findUnique({
    where: { normalizedPhone: input.normalizedPhone },
    select: { id: true },
  });
  const existing = await tx.suppressionEntry.findUnique({
    where: { normalizedPhone: input.normalizedPhone },
  });
  const reason = existing?.reason === "OPT_OUT" ? "OPT_OUT" : input.reason;
  await tx.suppressionEntry.upsert({
    where: { normalizedPhone: input.normalizedPhone },
    create: {
      normalizedPhone: input.normalizedPhone,
      contactId: contact?.id,
      reason,
      source: input.source,
      notes: "Global suppression created from an inbound SMS outcome",
      createdByUserId: input.actorUserId,
    },
    update: {
      contactId: contact?.id,
      reason,
      source: input.source,
      notes: "Global suppression created from an inbound SMS outcome",
    },
  });

  const campaignContacts = await tx.campaignContact.findMany({
    where: { contact: { normalizedPhone: input.normalizedPhone } },
    select: { id: true, campaignId: true, contactId: true },
  });
  for (const campaignContact of campaignContacts)
    await upsertCampaignSuppressionTx(tx, {
      campaignId: campaignContact.campaignId,
      contactId: campaignContact.contactId,
      normalizedPhone: input.normalizedPhone,
      reason,
      source: input.source,
      actorUserId: input.actorUserId,
    });

  const ids = campaignContacts.map((item) => item.id);
  if (ids.length) {
    await tx.campaignContact.updateMany({
      where: { id: { in: ids } },
      data: {
        status: reason === "OPT_OUT" ? "OPTED_OUT" : "SUPPRESSED",
        errorCode: reason,
        errorMessage: "Suppressed by inbound SMS outcome",
      },
    });
    await tx.smsConversation.updateMany({
      where: { campaignContactId: { in: ids } },
      data: { status: "SUPPRESSED", closedAt: input.occurredAt },
    });
    await tx.smsOutboundMessage.updateMany({
      where: {
        campaignContactId: { in: ids },
        status: { in: ["PENDING", "SCHEDULED", "QUEUED"] },
      },
      data: {
        status: "SUPPRESSED",
        canceledAt: input.occurredAt,
        errorCode: reason,
        errorMessage: "Suppressed by inbound SMS outcome",
      },
    });
  }

  const sequences = await tx.outreachSequence.findMany({
    where: { campaignContactId: { in: ids } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const sequence of sequences)
    await transitionSmsSequenceTx(tx, {
      sequenceId: sequence.id,
      type:
        sequence.id === input.targetSequenceId
          ? "SMS_REPLIED"
          : "OUTCOME_RECORDED",
      resultingState: reason,
      idempotencyKey: `${input.idempotencyBase}:sequence:${sequence.id}`,
      source: input.source,
      occurredAt: input.occurredAt,
      actorUserId: input.actorUserId,
      outcome: reason,
      projection: {
        smsRespondedAt: input.occurredAt,
        terminalAt: input.occurredAt,
        terminalReason: reason,
        coldCallDueAt: null,
        coldCallEligibleAt: null,
        nextEligibleAt: null,
      },
    });
}

async function markCampaignReplyTx(
  tx: Tx,
  input: {
    campaignId: string;
    contactId: string;
    sequenceId?: string;
    normalizedPhone: string;
    occurredAt: Date;
    idempotencyBase: string;
    source?: string;
    terminalReason?: string;
  },
) {
  const source = input.source ?? "sms_inbound_reply";
  const terminalReason = input.terminalReason ?? "SMS_REPLIED";
  await lockSmsPhoneDispatchTx(tx, input.normalizedPhone);
  await upsertCampaignSuppressionTx(tx, {
    campaignId: input.campaignId,
    contactId: input.contactId,
    normalizedPhone: input.normalizedPhone,
    reason: "COMPLIANCE",
    source,
  });
  await tx.smsOutboundMessage.updateMany({
    where: {
      campaignContact: {
        campaignId: input.campaignId,
        contact: { normalizedPhone: input.normalizedPhone },
      },
      status: { in: ["PENDING", "SCHEDULED", "QUEUED"] },
    },
    data: {
      status: "SUPPRESSED",
      canceledAt: input.occurredAt,
      errorCode: "INBOUND_REPLY",
      errorMessage: "Campaign outreach stopped after an inbound reply",
    },
  });
  if (!input.sequenceId) return;
  const sequence = await tx.outreachSequence.findUnique({
    where: { id: input.sequenceId },
  });
  if (!sequence) return;
  const resultingState = sequence.terminalAt
    ? sequence.currentState
    : "SMS_REPLIED";
  await transitionSmsSequenceTx(tx, {
    sequenceId: sequence.id,
    type: resultingState === "SMS_REPLIED" ? "SMS_REPLIED" : "OUTCOME_RECORDED",
    resultingState,
    idempotencyKey: `${input.idempotencyBase}:sequence:${sequence.id}`,
    source,
    occurredAt: input.occurredAt,
    outcome: "INBOUND_REPLY",
    projection: {
      smsRespondedAt: sequence.smsRespondedAt ?? input.occurredAt,
      terminalAt: sequence.terminalAt ?? input.occurredAt,
      terminalReason: sequence.terminalReason ?? terminalReason,
      coldCallDueAt: null,
      coldCallEligibleAt: null,
      nextEligibleAt: null,
    },
  });
}

async function recordSmsInboundOnce(
  input: ReturnType<typeof normalizedInbound>,
): Promise<RecordedSmsInbound> {
  const identity = smsInboundProviderIdentity(
    input.providerKey,
    input.providerMessageId,
  );
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw<Array<{ lock: string }>>`
        SELECT pg_advisory_xact_lock(
          hashtext(${`sms-inbound:${identity}`})
        )::text AS "lock"
      `;
      // Every reply blocks more outreach. Claim the same phone lock that a
      // live dispatcher holds before doing any matching or suppression work.
      await lockSmsPhoneDispatchTx(tx, input.fromPhone);
      const existing = await tx.smsInboundMessage.findUnique({
        where: {
          providerKey_providerMessageId: {
            providerKey: input.providerKey,
            providerMessageId: input.providerMessageId,
          },
        },
      });
      if (existing) {
        assertDuplicateMatches(existing, input);
        if (
          input.isOptOut &&
          !existing.isOptOut &&
          existing.classification !== "OPT_OUT"
        ) {
          await globallySuppressPhoneTx(tx, {
            normalizedPhone: input.fromPhone,
            reason: "OPT_OUT",
            source: input.optOutSource,
            occurredAt: input.receivedAt,
            idempotencyBase: `sms-inbound:${identity}:provider-opt-out-promotion`,
          });
          await tx.smsInboundMessage.update({
            where: { id: existing.id },
            data: {
              classification: "OPT_OUT",
              classificationSource: "PROVIDER_OR_KEYWORD",
              classificationConfidence: 1,
              classifiedAt: input.receivedAt,
              isOptOut: true,
            },
          });
          return {
            messageId: existing.id,
            conversationId: existing.conversationId,
            matchedOutboundMessageId: existing.inReplyToMessageId,
            duplicate: true,
            classification: "OPT_OUT",
          };
        }
        return {
          messageId: existing.id,
          conversationId: existing.conversationId,
          matchedOutboundMessageId: existing.inReplyToMessageId,
          duplicate: true,
          classification: existing.classification,
        };
      }

      const matchIds = await tx.$queryRaw<
        Array<{ id: string; contextAt: Date }>
      >`
        WITH candidates AS (
          SELECT "id",
            COALESCE("sentAt", "acceptedAt", "createdAt") AS "contextAt"
          FROM "SmsOutboundMessage"
          WHERE "providerKey" = ${input.providerKey}
            AND "toPhone" = ${input.fromPhone}
            AND "fromPhone" = ${input.toPhone}
            AND "status" IN (
              'SUBMISSION_UNKNOWN'::"SmsMessageStatus",
              'ACCEPTED'::"SmsMessageStatus",
              'SENT'::"SmsMessageStatus",
              'DELIVERED'::"SmsMessageStatus",
              'REPLIED'::"SmsMessageStatus"
            )
        )
        SELECT "id", "contextAt"
        FROM candidates
        WHERE "contextAt" = (SELECT MAX("contextAt") FROM candidates)
        ORDER BY "id" ASC
      `;
      // Twilio chooses a Messaging Service sender during submission. A reply
      // can beat the response/status callback that persists that E.164 From.
      // Compare null-sender rows even when an older exact-sender row exists;
      // otherwise a reply can be attributed to the old campaign while the new
      // campaign continues toward cold calling.
      const nullSenderCandidates = await tx.$queryRaw<
        Array<{ id: string; contextAt: Date }>
      >`
        SELECT "id", COALESCE("sentAt", "acceptedAt", "createdAt") AS "contextAt"
        FROM "SmsOutboundMessage"
        WHERE "providerKey" = ${input.providerKey}
          AND "toPhone" = ${input.fromPhone}
          AND "fromPhone" IS NULL
          AND "status" IN (
            'SUBMISSION_UNKNOWN'::"SmsMessageStatus",
            'ACCEPTED'::"SmsMessageStatus",
            'SENT'::"SmsMessageStatus",
            'DELIVERED'::"SmsMessageStatus",
            'REPLIED'::"SmsMessageStatus"
          )
        ORDER BY "id" ASC
      `;
      const exactContextAt = matchIds[0]?.contextAt.getTime();
      const unresolvedSenderMatchIds = nullSenderCandidates.filter(
        (candidate) =>
          exactContextAt === undefined ||
          candidate.contextAt.getTime() >= exactContextAt,
      );
      const unresolvedSenderMatch = unresolvedSenderMatchIds.length > 0;
      const ambiguousMatch =
        matchIds.length > 1 || (matchIds.length > 0 && unresolvedSenderMatch);
      const reviewMatchIds = [
        ...(ambiguousMatch ? matchIds.map((candidate) => candidate.id) : []),
        ...unresolvedSenderMatchIds.map((candidate) => candidate.id),
      ];
      const matched =
        matchIds[0] && !ambiguousMatch && !unresolvedSenderMatch
          ? await tx.smsOutboundMessage.findUnique({
              where: { id: matchIds[0].id },
              include: {
                campaignContact: {
                  include: {
                    contact: true,
                    outreachSequence: true,
                    smsConversation: true,
                  },
                },
                conversation: true,
              },
            })
          : null;
      const fallbackContact = matched
        ? matched.campaignContact.contact
        : await tx.contact.findUnique({
            where: { normalizedPhone: input.fromPhone },
          });

      let conversation =
        matched?.campaignContact.smsConversation ??
        matched?.conversation ??
        null;
      if (matched) {
        if (input.providerConversationId) {
          const providerConversation = await tx.smsConversation.findUnique({
            where: {
              providerKey_providerConversationId: {
                providerKey: input.providerKey,
                providerConversationId: input.providerConversationId,
              },
            },
          });
          if (
            providerConversation &&
            providerConversation.campaignContactId !== matched.campaignContactId
          )
            throw new Error(
              "Provider conversation is already linked to another contact",
            );
        }
        if (
          conversation?.providerKey &&
          conversation.providerKey !== input.providerKey
        )
          throw new Error(
            "Conversation is already associated with another SMS provider",
          );
        if (
          input.providerConversationId &&
          conversation?.providerConversationId &&
          conversation.providerConversationId !== input.providerConversationId
        )
          throw new Error(
            "Conversation is already associated with another provider conversation",
          );
        conversation = await tx.smsConversation.upsert({
          where: { campaignContactId: matched.campaignContactId },
          create: {
            campaignContactId: matched.campaignContactId,
            providerKey: input.providerKey,
            providerConversationId: input.providerConversationId,
            status: input.isOptOut ? "SUPPRESSED" : "OPEN",
            openedAt: matched.createdAt,
            lastOutboundAt:
              matched.sentAt ?? matched.acceptedAt ?? matched.createdAt,
            lastInboundAt: input.receivedAt,
            lastMessageAt: input.receivedAt,
            closedAt: input.isOptOut ? input.receivedAt : null,
          },
          update: {
            providerKey: input.providerKey,
            ...(input.providerConversationId
              ? { providerConversationId: input.providerConversationId }
              : {}),
            status:
              input.isOptOut || conversation?.status === "SUPPRESSED"
                ? "SUPPRESSED"
                : "OPEN",
            lastOutboundAt: later(
              conversation?.lastOutboundAt ?? null,
              matched.sentAt ?? matched.acceptedAt ?? matched.createdAt,
            ),
            lastInboundAt: later(
              conversation?.lastInboundAt ?? null,
              input.receivedAt,
            ),
            lastMessageAt: later(
              conversation?.lastMessageAt ?? null,
              input.receivedAt,
            ),
            ...(input.isOptOut ? { closedAt: input.receivedAt } : {}),
          },
        });
      }

      const classification: SmsInboundClassification = input.isOptOut
        ? "OPT_OUT"
        : ambiguousMatch || unresolvedSenderMatch
          ? "NEEDS_REVIEW"
          : "UNCLASSIFIED";
      const inbound = await tx.smsInboundMessage.create({
        data: {
          conversationId: conversation?.id,
          contactId: fallbackContact?.id,
          campaignContactId: matched?.campaignContactId,
          inReplyToMessageId: matched?.id,
          providerKey: input.providerKey,
          providerMessageId: input.providerMessageId,
          fromPhone: input.fromPhone,
          toPhone: input.toPhone,
          body: input.body,
          classification,
          classificationSource: input.isOptOut ? "PROVIDER_OR_KEYWORD" : null,
          classificationConfidence: input.isOptOut ? 1 : null,
          classifiedAt: input.isOptOut ? input.receivedAt : null,
          isOptOut: input.isOptOut,
          rawPayload: input.rawPayload,
          receivedAt: input.receivedAt,
        },
      });

      if (matched) {
        await tx.smsOutboundMessage.update({
          where: { id: matched.id },
          data: {
            conversationId: conversation?.id,
            status: "REPLIED",
            repliedAt: matched.repliedAt ?? input.receivedAt,
          },
        });
        const sequence = matched.campaignContact.outreachSequence;
        if (input.isOptOut)
          await globallySuppressPhoneTx(tx, {
            normalizedPhone: input.fromPhone,
            reason: "OPT_OUT",
            source: input.optOutSource,
            occurredAt: input.receivedAt,
            idempotencyBase: `sms-inbound:${identity}`,
            targetSequenceId: sequence?.id,
          });
        else
          await markCampaignReplyTx(tx, {
            campaignId: matched.campaignContact.campaignId,
            contactId: matched.campaignContact.contactId,
            sequenceId: sequence?.id,
            normalizedPhone: input.fromPhone,
            occurredAt: input.receivedAt,
            idempotencyBase: `sms-inbound:${identity}`,
          });
      } else if (input.isOptOut) {
        await globallySuppressPhoneTx(tx, {
          normalizedPhone: input.fromPhone,
          reason: "OPT_OUT",
          source: input.optOutSource,
          occurredAt: input.receivedAt,
          idempotencyBase: `sms-inbound:${identity}`,
        });
      } else if (reviewMatchIds.length) {
        // Preserve attribution as null, but place every plausible candidate
        // campaign on a safety hold so none can reach BatchDialer.
        const candidateContacts = await tx.campaignContact.findMany({
          where: {
            outboundMessages: {
              some: { id: { in: reviewMatchIds } },
            },
          },
          select: {
            id: true,
            campaignId: true,
            contactId: true,
            outreachSequence: { select: { id: true } },
          },
          orderBy: { id: "asc" },
        });
        for (const candidate of candidateContacts) {
          await markCampaignReplyTx(tx, {
            campaignId: candidate.campaignId,
            contactId: candidate.contactId,
            sequenceId: candidate.outreachSequence?.id,
            normalizedPhone: input.fromPhone,
            occurredAt: input.receivedAt,
            idempotencyBase: `sms-inbound:${identity}:review:${candidate.id}`,
            source: ambiguousMatch
              ? "sms_inbound_ambiguous_reply_hold"
              : "sms_inbound_unresolved_sender_reply_hold",
            terminalReason: ambiguousMatch
              ? "AMBIGUOUS_SMS_REPLY_REVIEW"
              : "UNRESOLVED_SENDER_SMS_REPLY_REVIEW",
          });
        }
      }

      await tx.smsAuditEvent.create({
        data: {
          eventType: "SMS_INBOUND_RECEIVED",
          entityType: "SmsInboundMessage",
          entityId: inbound.id,
          campaignId: matched?.campaignContact.campaignId,
          campaignContactId: matched?.campaignContactId,
          idempotencyKey: `sms-inbound-audit:${identity}`,
          source: "sms_provider_webhook",
          after: {
            providerKey: input.providerKey,
            providerMessageId: input.providerMessageId,
            classification,
            matchedOutboundMessageId: matched?.id ?? null,
            ambiguousMatch,
            ambiguousCandidateCount: ambiguousMatch ? matchIds.length : 0,
            unresolvedSenderMatch,
            unresolvedSenderCandidateCount: unresolvedSenderMatchIds.length,
          },
          occurredAt: input.receivedAt,
        },
      });

      return {
        messageId: inbound.id,
        conversationId: conversation?.id ?? null,
        matchedOutboundMessageId: matched?.id ?? null,
        duplicate: false,
        classification,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 60_000,
    },
  );
}

export async function recordSmsInboundMessage(
  rawInput: RecordSmsInboundInput,
): Promise<RecordedSmsInbound> {
  const input = normalizedInbound(rawInput);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await recordSmsInboundOnce(input);
    } catch (error) {
      if (
        attempt < 3 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" || error.code === "P2002")
      )
        continue;
      throw error;
    }
  }
  throw new Error("Inbound SMS could not be recorded");
}

function classificationState(
  currentState: OutreachSequenceState,
  policy: SmsInboundClassificationPolicy,
) {
  return policy.sequenceState ?? currentState;
}

export async function classifySmsInboundMessage(input: {
  messageId: string;
  classification: SmsInboundClassification;
  actorUserId: string;
}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT "id" FROM "SmsInboundMessage"
            WHERE "id" = ${input.messageId}::uuid
            FOR UPDATE
          `;
          const inbound = await tx.smsInboundMessage.findUnique({
            where: { id: input.messageId },
            include: {
              conversation: true,
              campaignContact: {
                include: { outreachSequence: true, contact: true },
              },
            },
          });
          if (!inbound) throw new Error("Inbound SMS message not found");
          if (
            inbound.classification === input.classification &&
            inbound.classificationSource === "USER"
          )
            return { message: inbound, duplicate: true as const };

          const now = new Date();
          const policy = smsInboundClassificationPolicy(input.classification);
          const auditIdentity = randomUUID();
          let creditedEventId: string | undefined;
          const campaignContact = inbound.campaignContact;

          if (policy.globalSuppression) {
            await globallySuppressPhoneTx(tx, {
              normalizedPhone: inbound.fromPhone,
              reason: policy.globalSuppression,
              source: "sms_inbox_classification",
              occurredAt: inbound.receivedAt,
              idempotencyBase: `sms-classification:${inbound.id}:${auditIdentity}`,
              actorUserId: input.actorUserId,
              targetSequenceId: campaignContact?.outreachSequence?.id,
            });
          } else if (campaignContact) {
            await upsertCampaignSuppressionTx(tx, {
              campaignId: campaignContact.campaignId,
              contactId: campaignContact.contactId,
              normalizedPhone: inbound.fromPhone,
              reason: "COMPLIANCE",
              source: "sms_inbox_classification",
              actorUserId: input.actorUserId,
            });
            const sequence = campaignContact.outreachSequence;
            if (sequence) {
              const eventKey = `sms-classification:${inbound.id}:${auditIdentity}:sequence:${sequence.id}`;
              await transitionSmsSequenceTx(tx, {
                sequenceId: sequence.id,
                type: "OUTCOME_RECORDED",
                resultingState: classificationState(
                  sequence.currentState,
                  policy,
                ),
                idempotencyKey: eventKey,
                source: "sms_inbox_classification",
                occurredAt: now,
                actorUserId: input.actorUserId,
                outcome: input.classification,
                projection: {
                  smsRespondedAt: sequence.smsRespondedAt ?? inbound.receivedAt,
                  terminalAt: sequence.terminalAt ?? inbound.receivedAt,
                  terminalReason:
                    policy.sequenceState ??
                    sequence.terminalReason ??
                    "SMS_REPLIED",
                  coldCallDueAt: null,
                  coldCallEligibleAt: null,
                  nextEligibleAt: null,
                },
              });
              creditedEventId = (
                await tx.outreachEvent.findUnique({
                  where: { idempotencyKey: eventKey },
                  select: { id: true },
                })
              )?.id;
            }
          }

          if (policy.createsLead && campaignContact) {
            const existingLead = await tx.leadAttribution.findUnique({
              where: { campaignContactId: campaignContact.id },
              select: { id: true },
            });
            if (!existingLead)
              await tx.leadAttribution.create({
                data: {
                  campaignContactId: campaignContact.id,
                  campaignId: campaignContact.campaignId,
                  creditedChannel: "SMS",
                  creditedEventId,
                  qualifyingOutcome: "QUALIFIED_LEAD",
                  attributedAt: now,
                },
              });
          }

          if (inbound.conversation) {
            const suppressed =
              inbound.conversation.status === "SUPPRESSED" ||
              Boolean(policy.globalSuppression);
            await tx.smsConversation.update({
              where: { id: inbound.conversation.id },
              data: {
                status: suppressed
                  ? "SUPPRESSED"
                  : policy.closesConversation
                    ? "CLOSED"
                    : "OPEN",
                closedAt:
                  suppressed || policy.closesConversation
                    ? (inbound.conversation.closedAt ?? now)
                    : null,
              },
            });
          }

          const updated = await tx.smsInboundMessage.update({
            where: { id: inbound.id },
            data: {
              classification: input.classification,
              classificationSource: "USER",
              classificationConfidence: null,
              classifiedAt: now,
              classifiedByUserId: input.actorUserId,
              isOptOut: inbound.isOptOut || input.classification === "OPT_OUT",
            },
          });
          await tx.smsAuditEvent.create({
            data: {
              eventType: "SMS_INBOUND_CLASSIFIED",
              entityType: "SmsInboundMessage",
              entityId: inbound.id,
              campaignId: campaignContact?.campaignId,
              campaignContactId: campaignContact?.id,
              actorUserId: input.actorUserId,
              idempotencyKey: `sms-classification-audit:${inbound.id}:${auditIdentity}`,
              source: "sms_inbox",
              before: { classification: inbound.classification },
              after: { classification: input.classification },
              occurredAt: now,
            },
          });
          return { message: updated, duplicate: false as const };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 60_000,
        },
      );
    } catch (error) {
      if (
        attempt < 3 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      )
        continue;
      throw error;
    }
  }
  throw new Error("Inbound SMS classification could not be saved");
}
