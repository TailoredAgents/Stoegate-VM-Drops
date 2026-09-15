import { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { normalizeUSPhone } from "@/lib/phone";
import { isProviderOptOutSignal } from "@/lib/provider-suppression";
import { withSmsPhoneDispatchLock } from "@/lib/sms-dispatch-lock";
import { persistSmsDeliveryStatus } from "@/lib/sms-operations";
import { recordSmsInboundMessage } from "@/lib/sms-conversations";
import {
  suppressPhoneGlobally,
  suppressPhoneGloballyWhileDispatchLocked,
} from "@/lib/suppression";

const providerKey = z.string().trim().min(1).max(100);
const providerIdentifier = z.string().trim().min(1).max(300);
const timestamp = z.iso.datetime({ offset: true });
const rawProviderPayload = z.record(z.string(), z.unknown()).optional();

const deliveryEventSchema = z.object({
  type: z.literal("delivery_status"),
  providerKey,
  providerEventId: providerIdentifier,
  providerMessageId: providerIdentifier,
  clientReference: z.uuid().optional(),
  status: z.enum(["sent", "delivered", "undelivered", "failed", "rejected"]),
  occurredAt: timestamp,
  segments: z.number().int().positive().optional(),
  costMicros: z.number().int().nonnegative().optional(),
  currency: z.string().trim().length(3).optional(),
  failureCode: z.string().trim().max(200).optional(),
  failureReason: z.string().trim().max(2_000).optional(),
  rawPayload: rawProviderPayload,
});

const inboundEventSchema = z.object({
  type: z.literal("inbound_message"),
  providerKey,
  providerMessageId: providerIdentifier,
  providerConversationId: providerIdentifier.optional(),
  from: z.string().trim().min(1).max(100),
  to: z.string().trim().min(1).max(100),
  body: z.string().max(10_000),
  receivedAt: timestamp,
  providerOptOut: z.boolean().optional(),
  media: z
    .array(
      z.object({
        url: z.url().optional(),
        contentType: z.string().trim().max(200).optional(),
        providerMediaId: providerIdentifier.optional(),
      }),
    )
    .max(20)
    .optional(),
  rawPayload: rawProviderPayload,
});

export const canonicalSmsWebhookSchema = z.discriminatedUnion("type", [
  deliveryEventSchema,
  inboundEventSchema,
]);

export type CanonicalSmsWebhook = z.infer<typeof canonicalSmsWebhookSchema>;

async function reconcileProviderOptOutSignal(
  event: {
    providerKey: string;
    providerEventId: string;
    errorCode: string | null;
    rawPayload: unknown;
    occurredAt: Date | null;
    receivedAt: Date;
  },
  storedRecipient: string,
  phoneDispatchLockAlreadyHeld = false,
) {
  if (!isProviderOptOutSignal(event.providerKey, event.errorCode)) return false;
  const rawRecord =
    event.rawPayload &&
    typeof event.rawPayload === "object" &&
    !Array.isArray(event.rawPayload)
      ? (event.rawPayload as Record<string, unknown>)
      : null;
  const rawTo = typeof rawRecord?.To === "string" ? rawRecord.To : undefined;
  const normalizedPhone = normalizeUSPhone(storedRecipient);
  if (!normalizedPhone) return true;
  if (rawTo) {
    const callbackRecipient = normalizeUSPhone(rawTo);
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
    occurredAt: event.occurredAt ?? event.receivedAt,
    idempotencyKey: `twilio-provider-opt-out:${event.providerEventId}`,
  });
  return true;
}

async function markProviderOptOutProcessed(
  event: { providerKey: string; providerEventId: string },
  messageId: string,
) {
  await db.smsStatusEvent.updateMany({
    where: {
      providerKey: event.providerKey,
      providerEventId: event.providerEventId,
      messageId,
    },
    data: { processedAt: new Date(), processingError: null },
  });
}

export function parseCanonicalSmsWebhook(rawBody: string): CanonicalSmsWebhook {
  return canonicalSmsWebhookSchema.parse(JSON.parse(rawBody));
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function processCanonicalSmsWebhook(
  event: CanonicalSmsWebhook,
): Promise<Record<string, unknown>> {
  const rawPayload = asJson(event.rawPayload ?? event);
  if (event.type === "inbound_message") {
    const result = await recordSmsInboundMessage({
      providerKey: event.providerKey,
      providerMessageId: event.providerMessageId,
      providerConversationId: event.providerConversationId,
      from: event.from,
      to: event.to,
      body: event.body,
      receivedAt: new Date(event.receivedAt),
      providerOptOut: event.providerOptOut,
      rawPayload: event.rawPayload ?? event,
    });
    return { kind: "inbound_message", ...result };
  }

  const message = await db.smsOutboundMessage.findFirst({
    where: event.clientReference
      ? {
          id: event.clientReference,
          providerKey: event.providerKey,
          OR: [
            { providerMessageId: event.providerMessageId },
            { providerMessageId: null },
          ],
        }
      : {
          providerKey: event.providerKey,
          providerMessageId: event.providerMessageId,
        },
    select: { id: true, toPhone: true },
  });
  if (!message) {
    const existing = await db.smsStatusEvent.findUnique({
      where: {
        providerKey_providerEventId: {
          providerKey: event.providerKey,
          providerEventId: event.providerEventId,
        },
      },
      select: { id: true },
    });
    if (!existing)
      await db.smsStatusEvent.create({
        data: {
          providerKey: event.providerKey,
          providerEventId: event.providerEventId,
          providerMessageId: event.providerMessageId,
          providerStatus: event.status,
          status:
            event.status === "delivered"
              ? "DELIVERED"
              : event.status === "sent"
                ? "SENT"
                : event.status === "undelivered"
                  ? "UNDELIVERED"
                  : "FAILED",
          rawPayload,
          occurredAt: new Date(event.occurredAt),
          processedAt: new Date(),
          processingError: "No outbound SMS matched this provider message ID",
          errorCode: event.failureCode ?? null,
          errorMessage: event.failureReason ?? null,
        },
      });
    return {
      kind: "delivery_status",
      matched: false,
      duplicate: Boolean(existing),
    };
  }

  const persistMatchedStatus = async (
    phoneDispatchLockAlreadyHeld: boolean,
  ) => {
    const result = await persistSmsDeliveryStatus({
      messageId: message.id,
      providerKey: event.providerKey,
      providerEventId: event.providerEventId,
      providerMessageId: event.providerMessageId,
      providerStatus: event.status,
      outcome:
        event.status === "delivered"
          ? "DELIVERED"
          : event.status === "sent"
            ? "SENT"
            : event.status === "undelivered"
              ? "UNDELIVERED"
              : "FAILED",
      rawPayload,
      actualSegmentCount: event.segments,
      actualCostMicros: event.costMicros,
      currency: event.currency,
      errorCode: event.failureCode,
      errorMessage: event.failureReason,
      occurredAt: new Date(event.occurredAt),
    });
    if (
      await reconcileProviderOptOutSignal(
        {
          providerKey: event.providerKey,
          providerEventId: event.providerEventId,
          errorCode: event.failureCode ?? null,
          rawPayload,
          occurredAt: new Date(event.occurredAt),
          receivedAt: new Date(),
        },
        message.toPhone,
        phoneDispatchLockAlreadyHeld,
      )
    ) {
      await markProviderOptOutProcessed(event, message.id);
    }
    return {
      kind: "delivery_status",
      matched: true,
      duplicate: result.reason === "already_recorded",
      status: result.messageStatus,
      applied: result.updated,
    };
  };

  const normalizedPhone = normalizeUSPhone(message.toPhone);
  if (
    normalizedPhone &&
    isProviderOptOutSignal(event.providerKey, event.failureCode)
  ) {
    return withSmsPhoneDispatchLock(normalizedPhone, () =>
      persistMatchedStatus(true),
    );
  }
  return persistMatchedStatus(false);
}

/**
 * Replays callbacks that beat the outbound provider-result transaction. Raw
 * events remain in PostgreSQL until a matching provider message ID exists.
 */
export async function reconcileUnmatchedSmsStatusEvents(limit = 100) {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const candidateIds = await db.$queryRaw<Array<{ id: string }>>`
    SELECT event."id"
    FROM "SmsStatusEvent" AS event
    WHERE event."providerMessageId" IS NOT NULL
      AND (
        (
          event."messageId" IS NULL
          AND (
            event."status" IN ('ACCEPTED', 'SENT', 'DELIVERED', 'UNDELIVERED', 'FAILED')
            OR (event."providerKey" = 'twilio' AND event."status" IS NULL)
          )
        )
        OR (
          event."messageId" IS NOT NULL
          AND event."providerKey" = 'twilio'
          AND event."errorCode" = '21610'
          AND event."processedAt" IS NULL
        )
      )
      AND EXISTS (
        SELECT 1
        FROM "SmsOutboundMessage" AS message
        WHERE message."providerKey" = event."providerKey"
          AND message."providerMessageId" = event."providerMessageId"
          AND (event."messageId" IS NULL OR event."messageId" = message."id")
      )
    ORDER BY event."receivedAt" ASC, event."id" ASC
    LIMIT ${boundedLimit}
  `;
  if (!candidateIds.length) return { examined: 0, matched: 0 };

  const events = await db.smsStatusEvent.findMany({
    where: {
      id: { in: candidateIds.map((event) => event.id) },
      providerMessageId: { not: null },
      OR: [
        {
          messageId: null,
          OR: [
            {
              status: {
                in: ["ACCEPTED", "SENT", "DELIVERED", "UNDELIVERED", "FAILED"],
              },
            },
            { providerKey: "twilio", status: null },
          ],
        },
        {
          messageId: { not: null },
          providerKey: "twilio",
          errorCode: "21610",
          processedAt: null,
        },
      ],
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
  });
  let matched = 0;
  for (const event of events) {
    const message = await db.smsOutboundMessage.findFirst({
      where: {
        providerKey: event.providerKey,
        providerMessageId: event.providerMessageId!,
      },
      select: { id: true, toPhone: true },
    });
    if (!message || (event.messageId && event.messageId !== message.id))
      continue;
    try {
      const reconcileEvent = async (phoneDispatchLockAlreadyHeld: boolean) => {
        if (event.status === null) {
          let attachedCount = 0;
          if (!event.messageId) {
            const attached = await db.smsStatusEvent.updateMany({
              where: { id: event.id, messageId: null, status: null },
              data: {
                messageId: message.id,
                processedAt: isProviderOptOutSignal(
                  event.providerKey,
                  event.errorCode,
                )
                  ? null
                  : new Date(),
                processingError: null,
              },
            });
            attachedCount = attached.count;
          }
          if (
            await reconcileProviderOptOutSignal(
              event,
              message.toPhone,
              phoneDispatchLockAlreadyHeld,
            )
          ) {
            await markProviderOptOutProcessed(event, message.id);
          }
          matched += event.messageId ? 1 : attachedCount;
          return;
        }
        await persistSmsDeliveryStatus({
          messageId: message.id,
          providerKey: event.providerKey,
          providerEventId: event.providerEventId,
          providerMessageId: event.providerMessageId!,
          providerStatus: event.providerStatus,
          outcome: event.status as
            "ACCEPTED" | "SENT" | "DELIVERED" | "UNDELIVERED" | "FAILED",
          rawPayload: event.rawPayload,
          fromPhone:
            event.rawPayload &&
            typeof event.rawPayload === "object" &&
            !Array.isArray(event.rawPayload) &&
            typeof event.rawPayload.From === "string"
              ? event.rawPayload.From
              : undefined,
          errorCode: event.errorCode ?? undefined,
          errorMessage: event.errorMessage ?? undefined,
          occurredAt: event.occurredAt ?? event.receivedAt,
          receivedAt: event.receivedAt,
        });
        if (
          await reconcileProviderOptOutSignal(
            event,
            message.toPhone,
            phoneDispatchLockAlreadyHeld,
          )
        ) {
          await markProviderOptOutProcessed(event, message.id);
        }
        matched += 1;
      };

      const normalizedPhone = normalizeUSPhone(message.toPhone);
      if (
        normalizedPhone &&
        isProviderOptOutSignal(event.providerKey, event.errorCode)
      ) {
        await withSmsPhoneDispatchLock(normalizedPhone, () =>
          reconcileEvent(true),
        );
      } else {
        await reconcileEvent(false);
      }
    } catch (error) {
      await db.smsStatusEvent.update({
        where: { id: event.id },
        data: {
          processingError:
            error instanceof Error
              ? error.message.slice(0, 2_000)
              : "Could not reconcile provider status",
        },
      });
    }
  }
  return { examined: events.length, matched };
}

/**
 * Recover a final status returned synchronously by a provider if the worker
 * stopped after persisting acceptance but before projecting that status. The
 * provider request is never repeated; reconciliation works only from the
 * durable provider result already stored on the message and attempt.
 */
export async function reconcileSynchronousSmsProviderResults(limit = 100) {
  const messages = await db.smsOutboundMessage.findMany({
    where: {
      status: "ACCEPTED",
      providerKey: { not: null },
      providerMessageId: { not: null },
      providerStatus: { in: ["sent", "delivered", "undelivered"] },
    },
    orderBy: { acceptedAt: "asc" },
    take: Math.max(1, Math.min(500, Math.trunc(limit))),
    select: {
      id: true,
      providerKey: true,
      providerMessageId: true,
      providerStatus: true,
      actualSegmentCount: true,
      actualCostMicros: true,
      currency: true,
      acceptedAt: true,
      attempts: {
        orderBy: { attemptNumber: "desc" },
        take: 1,
        select: { id: true, responsePayload: true, finishedAt: true },
      },
    },
  });
  let recovered = 0;
  for (const message of messages) {
    const attempt = message.attempts[0];
    if (
      !attempt ||
      !message.providerKey ||
      !message.providerMessageId ||
      !message.providerStatus
    )
      continue;
    const outcome =
      message.providerStatus === "sent"
        ? ("SENT" as const)
        : message.providerStatus === "delivered"
          ? ("DELIVERED" as const)
          : ("UNDELIVERED" as const);
    const occurredAt = attempt.finishedAt ?? message.acceptedAt ?? new Date();
    const result = await persistSmsDeliveryStatus({
      messageId: message.id,
      providerKey: message.providerKey,
      providerEventId: `send-result:${attempt.id}:${message.providerStatus}`,
      providerMessageId: message.providerMessageId,
      providerStatus: message.providerStatus,
      outcome,
      rawPayload: attempt.responsePayload ?? {
        recoveredFromPersistedProviderResult: true,
      },
      actualSegmentCount: message.actualSegmentCount ?? undefined,
      actualCostMicros: message.actualCostMicros ?? undefined,
      currency:
        message.actualCostMicros === null ? undefined : message.currency,
      occurredAt,
      receivedAt: new Date(),
    });
    if (result.updated || result.reason === "already_recorded") recovered += 1;
  }
  return { examined: messages.length, recovered };
}
