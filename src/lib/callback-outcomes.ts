import {
  type AttributionChannel,
  type CallbackOutcomeType,
  Prisma,
} from "@prisma/client";
import { z } from "zod";
import { lookupCallback } from "@/lib/callback-matching";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { normalizeUSPhone } from "@/lib/phone";
import { applyCallbackOutcomeToSequencesTx } from "@/lib/outreach-service";

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
  attribution_channel: z
    .enum(["rvm_callback", "sms", "cold_call", "other"])
    .default("rvm_callback"),
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

const attributionMap = {
  rvm_callback: "RVM_CALLBACK",
  sms: "SMS",
  cold_call: "COLD_CALL",
  other: "OTHER",
} as const;

type ParsedCallbackResult = z.infer<typeof callbackResultSchema>;

function callbackCommandIdentity(
  input: ParsedCallbackResult,
  normalizedPhone: string,
) {
  return JSON.stringify({
    normalizedPhone,
    outcome: outcomeMap[input.outcome],
    attributionChannel: attributionMap[input.attribution_channel],
    campaignId: input.campaign_id ?? null,
    campaignContactId: input.campaign_contact_id ?? null,
    stonegateLeadId: input.stonegate_os_lead_id ?? null,
    summary: input.callback_summary ?? null,
    callbackTimestamp: input.callback_timestamp ?? null,
    contractAmountCents: input.contract_amount_cents ?? null,
    revenueCents: input.revenue_cents ?? null,
  });
}

function assertMatchingCallbackRetry(
  existing: {
    normalizedPhone: string;
    outcome: CallbackOutcomeType;
    attributionChannel: AttributionChannel;
    rawPayload: Prisma.JsonValue | null;
  },
  input: ParsedCallbackResult,
  normalizedPhone: string,
) {
  const parsed = callbackResultSchema.safeParse(existing.rawPayload);
  const sameRawCommand =
    parsed.success &&
    normalizeUSPhone(parsed.data.phone) === normalizedPhone &&
    callbackCommandIdentity(parsed.data, normalizedPhone) ===
      callbackCommandIdentity(input, normalizedPhone);
  const sameCore =
    existing.normalizedPhone === normalizedPhone &&
    existing.outcome === outcomeMap[input.outcome] &&
    existing.attributionChannel === attributionMap[input.attribution_channel];
  if (!(parsed.success ? sameRawCommand : sameCore))
    throw new Error("Idempotency key was already used for another callback");
}

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
  if (duplicate) {
    assertMatchingCallbackRetry(duplicate, input, normalizedPhone);
    return { result: duplicate, duplicate: true };
  }

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
    }
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const callbackAt = input.callback_timestamp
        ? new Date(input.callback_timestamp)
        : new Date();
      const outcome = await tx.callbackOutcome.create({
        data: {
          idempotencyKey: input.idempotency_key,
          normalizedPhone,
          outcome: outcomeMap[input.outcome],
          attributionChannel: attributionMap[input.attribution_channel],
          campaignId,
          campaignContactId,
          stonegateLeadId: input.stonegate_os_lead_id,
          summary: input.callback_summary,
          callbackAt,
          contractAmountCents: input.contract_amount_cents,
          revenueCents: input.revenue_cents,
          rawPayload: raw as Prisma.InputJsonValue,
        },
      });
      await applyCallbackOutcomeToSequencesTx(tx, {
        normalizedPhone,
        outcome: outcomeMap[input.outcome],
        attributionChannel: attributionMap[input.attribution_channel],
        occurredAt: callbackAt,
        idempotencyKey: input.idempotency_key,
        creditedCampaignContactId: campaignContactId,
        rawPayload: raw,
        source: "stonegate_callback_ai",
      });
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
      if (raced) {
        assertMatchingCallbackRetry(raced, input, normalizedPhone);
        return { result: raced, duplicate: true };
      }
    }
    throw error;
  }
}
