import twilio from "twilio";

import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { normalizeUSPhone } from "@/lib/phone";

export interface TwilioCostMessageResource {
  sid: string;
  price?: string | null;
  priceUnit?: string | null;
  numSegments?: string | null;
  from?: string | null;
}

export interface TwilioCostClient {
  messages(sid: string): {
    fetch(): Promise<TwilioCostMessageResource>;
  };
}

export interface TwilioCostReconciliationResult {
  examined: number;
  reconciled: number;
  pendingPrice: number;
  failed: number;
}

export function twilioPriceToMicros(
  price: string | null | undefined,
): number | null {
  if (price == null || !price.trim()) return null;
  const parsed = Number(price);
  if (!Number.isFinite(parsed)) return null;
  const micros = Math.round(Math.abs(parsed) * 1_000_000);
  return Number.isSafeInteger(micros) && micros <= 2_147_483_647
    ? micros
    : null;
}

function actualSegments(value: string | null | undefined) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1_000
    ? parsed
    : undefined;
}

function actualCurrency(value: string | null | undefined) {
  const currency = value?.trim().toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

/**
 * Admin-triggered, bounded reconciliation for final messages whose Twilio
 * price was not yet populated in the original create response. This is never
 * scheduled automatically and never creates or sends a message.
 */
export async function reconcileTwilioMessageCosts(input: {
  actorUserId: string;
  limit?: number;
  client?: TwilioCostClient;
}): Promise<TwilioCostReconciliationResult> {
  const env = getEnv();
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials are required for cost reconciliation");
  }
  const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 25)));
  const client =
    input.client ??
    (twilio(
      env.TWILIO_ACCOUNT_SID,
      env.TWILIO_AUTH_TOKEN,
    ) as unknown as TwilioCostClient);
  const messages = await db.smsOutboundMessage.findMany({
    where: {
      providerKey: "twilio",
      providerMessageId: { not: null },
      actualCostMicros: null,
      status: { in: ["SENT", "DELIVERED", "UNDELIVERED", "FAILED"] },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      providerMessageId: true,
      fromPhone: true,
    },
  });
  const result: TwilioCostReconciliationResult = {
    examined: messages.length,
    reconciled: 0,
    pendingPrice: 0,
    failed: 0,
  };

  for (const message of messages) {
    try {
      const providerMessageId = message.providerMessageId!;
      const resource = await client.messages(providerMessageId).fetch();
      if (resource.sid !== providerMessageId) {
        throw new Error("Twilio returned a different Message SID");
      }
      const actualCostMicros = twilioPriceToMicros(resource.price);
      const currency = actualCurrency(resource.priceUnit);
      if (actualCostMicros === null || !currency) {
        result.pendingPrice += 1;
        continue;
      }
      const fromPhone = resource.from
        ? normalizeUSPhone(resource.from)
        : undefined;
      if (resource.from && !fromPhone) {
        throw new Error("Twilio returned an invalid originating number");
      }
      if (fromPhone && message.fromPhone && fromPhone !== message.fromPhone) {
        throw new Error("Twilio sender conflicts with the stored message");
      }
      const segmentCount = actualSegments(resource.numSegments);
      const updated = await db.$transaction(async (tx) => {
        const update = await tx.smsOutboundMessage.updateMany({
          where: { id: message.id, actualCostMicros: null },
          data: {
            actualCostMicros,
            currency,
            ...(segmentCount ? { actualSegmentCount: segmentCount } : {}),
            ...(fromPhone ? { fromPhone } : {}),
          },
        });
        if (update.count === 0) return false;
        await tx.smsAuditEvent.create({
          data: {
            eventType: "TWILIO_COST_RECONCILED",
            entityType: "SmsOutboundMessage",
            entityId: message.id,
            actorUserId: input.actorUserId,
            idempotencyKey: `twilio-cost:${message.id}:${actualCostMicros}:${currency}`,
            source: "twilio_cost_reconciliation",
            after: {
              providerMessageId,
              actualCostMicros,
              currency,
              actualSegmentCount: segmentCount ?? null,
              fromPhone: fromPhone ?? message.fromPhone,
            },
            occurredAt: new Date(),
          },
        });
        return true;
      });
      if (updated) result.reconciled += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
