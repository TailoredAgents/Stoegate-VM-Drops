import { randomUUID } from "node:crypto";
import {
  type OutreachSequenceState,
  Prisma,
  type SuppressionReason,
} from "@prisma/client";

import { db } from "@/lib/db";
import { lockSmsPhoneDispatchTx } from "@/lib/sms-dispatch-lock";

const preservedTerminalStates = new Set<OutreachSequenceState>([
  "INTERESTED",
  "QUALIFIED_LEAD",
  "FOLLOW_UP",
  "NOT_INTERESTED",
  "WRONG_NUMBER",
  "OPT_OUT",
  "CONTRACT",
  "CLOSED",
]);

export function suppressionSequenceState(
  current: OutreachSequenceState,
  reason: SuppressionReason,
): OutreachSequenceState {
  if (preservedTerminalStates.has(current)) return current;
  return reason === "WRONG_NUMBER" ? "WRONG_NUMBER" : "OPT_OUT";
}

export async function suppressPhoneGlobally(input: {
  normalizedPhone: string;
  reason: SuppressionReason;
  source: string;
  notes?: string;
  actorUserId?: string;
  occurredAt?: Date;
}) {
  const occurredAt = input.occurredAt ?? new Date();
  const commandId = randomUUID();
  return db.$transaction(
    async (tx) => {
      await lockSmsPhoneDispatchTx(tx, input.normalizedPhone);
      const contact = await tx.contact.findUnique({
        where: { normalizedPhone: input.normalizedPhone },
        select: { id: true },
      });
      const existing = await tx.suppressionEntry.findUnique({
        where: { normalizedPhone: input.normalizedPhone },
      });
      const protectedExisting =
        existing &&
        ["OPT_OUT", "PROVIDER_DNC", "WRONG_NUMBER"].includes(existing.reason);
      const reason =
        input.reason === "OPT_OUT" || existing?.reason === "OPT_OUT"
          ? "OPT_OUT"
          : protectedExisting
            ? existing.reason
            : input.reason;
      await tx.suppressionEntry.upsert({
        where: { normalizedPhone: input.normalizedPhone },
        create: {
          normalizedPhone: input.normalizedPhone,
          contactId: contact?.id,
          reason,
          source: input.source,
          notes: input.notes,
          createdByUserId: input.actorUserId,
        },
        update: {
          contactId: contact?.id,
          reason,
          source: input.source,
          notes: input.notes,
        },
      });

      const campaignContacts = await tx.campaignContact.findMany({
        where: {
          contact: { normalizedPhone: input.normalizedPhone },
          campaign: { kind: "SMS" },
        },
        select: {
          id: true,
          campaignId: true,
          contactId: true,
          outreachSequence: true,
        },
      });
      for (const campaignContact of campaignContacts) {
        await tx.campaignSuppression.upsert({
          where: {
            campaignId_normalizedPhone: {
              campaignId: campaignContact.campaignId,
              normalizedPhone: input.normalizedPhone,
            },
          },
          create: {
            campaignId: campaignContact.campaignId,
            contactId: campaignContact.contactId,
            normalizedPhone: input.normalizedPhone,
            reason,
            source: input.source,
            notes: input.notes,
            createdByUserId: input.actorUserId,
          },
          update: {
            contactId: campaignContact.contactId,
            reason,
            source: input.source,
            notes: input.notes,
          },
        });
        await tx.campaignContact.update({
          where: { id: campaignContact.id },
          data: {
            status: reason === "OPT_OUT" ? "OPTED_OUT" : "SUPPRESSED",
            errorCode: reason,
            errorMessage: "Phone is globally suppressed",
          },
        });
        if (campaignContact.outreachSequence) {
          const sequence = campaignContact.outreachSequence;
          const resultingState = suppressionSequenceState(
            sequence.currentState,
            reason,
          );
          await tx.outreachEvent.create({
            data: {
              sequenceId: sequence.id,
              type: "SEQUENCE_EXITED",
              channel: "SYSTEM",
              resultingState,
              occurredAt,
              source: input.source,
              idempotencyKey:
                "sms-suppression:" + commandId + ":sequence:" + sequence.id,
              actorUserId: input.actorUserId,
              outcome: reason,
              metadata: { normalizedPhone: input.normalizedPhone },
            },
          });
          await tx.outreachSequence.update({
            where: { id: sequence.id },
            data: {
              currentState: resultingState,
              terminalAt: sequence.terminalAt ?? occurredAt,
              terminalReason: sequence.terminalReason ?? reason,
              nextEligibleAt: null,
              coldCallDueAt: null,
              coldCallEligibleAt: null,
              lastEventAt: occurredAt,
              version: { increment: 1 },
            },
          });
        }
      }

      const ids = campaignContacts.map((row) => row.id);
      if (ids.length) {
        await tx.smsOutboundMessage.updateMany({
          where: {
            campaignContactId: { in: ids },
            status: { in: ["PENDING", "SCHEDULED", "QUEUED"] },
          },
          data: {
            status: "SUPPRESSED",
            canceledAt: occurredAt,
            errorCode: reason,
            errorMessage: "Phone is globally suppressed",
          },
        });
        await tx.smsConversation.updateMany({
          where: { campaignContactId: { in: ids } },
          data: { status: "SUPPRESSED", closedAt: occurredAt },
        });
      }
      await tx.smsAuditEvent.create({
        data: {
          eventType: "GLOBAL_SUPPRESSION_CREATED",
          entityType: "Phone",
          entityId: input.normalizedPhone,
          actorUserId: input.actorUserId,
          idempotencyKey: "sms-suppression:" + commandId,
          source: input.source,
          before: existing
            ? ({
                reason: existing.reason,
                source: existing.source,
              } as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          after: {
            reason,
            source: input.source,
            affectedCampaignContacts: ids.length,
          },
          occurredAt,
        },
      });
      return {
        sequenceCount: campaignContacts.filter((row) => row.outreachSequence)
          .length,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 60_000,
    },
  );
}
