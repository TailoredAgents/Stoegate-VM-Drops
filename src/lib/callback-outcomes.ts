import { Prisma } from "@prisma/client";
import { z } from "zod";
import { lookupCallback } from "@/lib/callback-matching";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { normalizeUSPhone } from "@/lib/phone";

export const callbackResultSchema = z.object({
  idempotency_key: z.string().min(8).max(200),
  phone: z.string(),
  outcome: z.enum([
    "callback",
    "interested",
    "qualified_lead",
    "not_interested",
    "wrong_number",
    "opt_out",
    "follow_up",
    "contract",
    "closed",
  ]),
  campaign_id: z.uuid().optional(),
  campaign_contact_id: z.uuid().optional(),
  stonegate_os_lead_id: z.string().max(200).optional(),
  callback_summary: z.string().max(10_000).optional(),
  callback_timestamp: z.iso.datetime().optional(),
  contract_amount_cents: z.number().int().nonnegative().optional(),
  revenue_cents: z.number().int().nonnegative().optional(),
});

const outcomeMap = {
  callback: "CALLBACK",
  interested: "INTERESTED",
  qualified_lead: "QUALIFIED_LEAD",
  not_interested: "NOT_INTERESTED",
  wrong_number: "WRONG_NUMBER",
  opt_out: "OPT_OUT",
  follow_up: "FOLLOW_UP",
  contract: "CONTRACT",
  closed: "CLOSED",
} as const;

export async function recordCallbackOutcome(
  raw: unknown,
  lookbackDays = getEnv().CALLBACK_LOOKBACK_DAYS,
) {
  const input = callbackResultSchema.parse(raw);
  const normalizedPhone = normalizeUSPhone(input.phone);
  if (!normalizedPhone) throw new Error("A valid US phone number is required");

  const duplicate = await db.callbackOutcome.findUnique({
    where: { idempotencyKey: input.idempotency_key },
  });
  if (duplicate) return { result: duplicate, duplicate: true };

  let campaignId = input.campaign_id;
  let campaignContactId = input.campaign_contact_id;
  if (campaignContactId) {
    const campaignContact = await db.campaignContact.findUnique({
      where: { id: campaignContactId },
      include: { contact: { select: { normalizedPhone: true } } },
    });
    if (!campaignContact) throw new Error("Unknown campaign_contact_id");
    if (campaignContact.contact.normalizedPhone !== normalizedPhone)
      throw new Error("Phone does not match campaign_contact_id");
    if (campaignId && campaignId !== campaignContact.campaignId)
      throw new Error("campaign_id does not match campaign_contact_id");
    campaignId = campaignContact.campaignId;
  } else {
    const match = await lookupCallback(normalizedPhone, lookbackDays);
    const candidates = campaignId
      ? match.candidates.filter(
          (candidate) =>
            candidate.drop.campaignContact.campaignId === campaignId,
        )
      : match.candidates;
    if (candidates.length === 1) {
      campaignContactId = candidates[0].campaignContactId;
      campaignId = candidates[0].drop.campaignContact.campaignId;
    } else if (candidates.length > 1) {
      throw new Error(
        "Callback attribution is ambiguous; provide campaign_contact_id",
      );
    }
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const outcome = await tx.callbackOutcome.create({
        data: {
          idempotencyKey: input.idempotency_key,
          normalizedPhone,
          outcome: outcomeMap[input.outcome],
          campaignId,
          campaignContactId,
          stonegateLeadId: input.stonegate_os_lead_id,
          summary: input.callback_summary,
          callbackAt: input.callback_timestamp
            ? new Date(input.callback_timestamp)
            : new Date(),
          contractAmountCents: input.contract_amount_cents,
          revenueCents: input.revenue_cents,
          rawPayload: raw as Prisma.InputJsonValue,
        },
      });
      if (input.outcome === "opt_out") {
        const contact = await tx.contact.findUnique({
          where: { normalizedPhone },
          select: { id: true },
        });
        await tx.suppressionEntry.upsert({
          where: { normalizedPhone },
          create: {
            normalizedPhone,
            contactId: contact?.id,
            reason: "OPT_OUT",
            source: "stonegate_callback_ai",
          },
          update: { reason: "OPT_OUT", source: "stonegate_callback_ai" },
        });
      }
      return outcome;
    });
    return { result, duplicate: false };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      const raced = await db.callbackOutcome.findUnique({
        where: { idempotencyKey: input.idempotency_key },
      });
      if (raced) return { result: raced, duplicate: true };
    }
    throw error;
  }
}
