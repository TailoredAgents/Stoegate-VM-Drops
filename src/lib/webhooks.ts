import { createHmac } from "node:crypto";
import { Prisma, type DropStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { normalizeUSPhone } from "@/lib/phone";
import { safeEqual, sha256 } from "@/lib/utils";
import {
  applyCallbackOutcomeToSequencesTx,
  recordRvmDeliveryTx,
} from "@/lib/outreach-service";
import { recordRvmSuccessUsageTx } from "@/lib/rvm-operations";
import { getAppSettings } from "@/lib/settings";
import { ensureOutreachBillingPeriod } from "@/lib/billing-economics";

const webhookSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    event_id: z.union([z.string(), z.number()]).optional(),
    drop_id: z.union([z.string(), z.number()]).optional(),
    foreign_id: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    phone_number: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    attempt_date: z.union([z.string(), z.number()]).optional(),
    reason: z.string().optional(),
    dnc: z.boolean().optional(),
    product_cost: z.union([z.string(), z.number()]).optional(),
    compliance_fee: z.union([z.string(), z.number()]).optional(),
    tts_fee: z.union([z.string(), z.number()]).optional(),
    network: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export function verifyDropCowboySignature(
  rawBody: string,
  signature: string | null,
  secret?: string,
): boolean {
  if (!secret) return false;
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(signature.replace(/^sha256=/, ""), expected);
}

export function normalizeWebhookPayload(raw: unknown) {
  const parsed = webhookSchema.parse(raw);
  const data = parsed.data ?? {};
  const eventType = String(
    parsed.type ?? parsed.status ?? data.status ?? "unknown",
  ).toLowerCase();
  const foreignId = String(parsed.foreign_id ?? data.foreign_id ?? "");
  const phoneRaw = parsed.phone_number ?? data.phone_number;
  const providerDropId = parsed.drop_id ?? data.drop_id;
  const nestedOccurred = data.attempt_date ?? data.timestamp;
  const occurredRaw =
    parsed.attempt_date ??
    parsed.timestamp ??
    (typeof nestedOccurred === "string" || typeof nestedOccurred === "number"
      ? nestedOccurred
      : undefined);
  return {
    eventType,
    foreignId,
    phone: phoneRaw == null ? null : normalizeUSPhone(phoneRaw),
    reason:
      parsed.reason ??
      (typeof data.reason === "string" ? data.reason : undefined),
    dnc: parsed.dnc ?? (typeof data.dnc === "boolean" ? data.dnc : false),
    providerEventId: String(
      parsed.event_id ??
        parsed.id ??
        data.event_id ??
        (providerDropId == null
          ? sha256(JSON.stringify(raw))
          : `${providerDropId}:${eventType}:${occurredRaw ?? ""}`),
    ),
    occurredAt:
      occurredRaw == null
        ? null
        : new Date(
            typeof occurredRaw === "number" && occurredRaw < 1_000_000_000_000
              ? occurredRaw * 1000
              : occurredRaw,
          ),
    raw: parsed,
  };
}

function mapDropStatus(eventType: string): DropStatus | null {
  if (eventType.includes("opted_out") || eventType.includes("opt-out"))
    return "OPTED_OUT";
  if (eventType.includes("delivered")) return "DELIVERED";
  if (eventType === "success") return "DELIVERED";
  if (eventType.includes("failed")) return "FAILED";
  if (eventType === "failure") return "FAILED";
  if (eventType.includes("queued")) return "QUEUED";
  if (eventType.includes("sent")) return "SENT";
  return null;
}

export function shouldApplyDropStatusTransition(
  current: DropStatus,
  incoming: DropStatus,
  currentErrorCode?: string | null,
) {
  if (incoming === "OPTED_OUT") return true;
  if (current === "OPTED_OUT" || current === "SKIPPED") return false;
  if (current === "DELIVERED") return false;
  if (current === "FAILED")
    return (
      incoming === "DELIVERED" && currentErrorCode === "RVM_SUBMISSION_UNKNOWN"
    );
  if (current === "DRY_RUN")
    return incoming === "DELIVERED" || incoming === "FAILED";

  const progress: Partial<Record<DropStatus, number>> = {
    PENDING: 0,
    QUEUED: 1,
    SENT: 2,
  };
  if (incoming === "DELIVERED" || incoming === "FAILED") return true;
  return (progress[incoming] ?? -1) > (progress[current] ?? -1);
}

export async function processDropCowboyWebhook(raw: unknown) {
  const event = normalizeWebhookPayload(raw);
  if (!event.foreignId) throw new Error("Webhook is missing foreign_id");
  const existing = await db.deliveryEvent.findUnique({
    where: { providerEventId: event.providerEventId },
  });
  if (existing) return { duplicate: true, eventId: existing.id };
  const drop = await db.drop.findUnique({
    where: { id: event.foreignId },
    include: { campaignContact: { include: { contact: true } } },
  });
  if (!drop) throw new Error("Unknown foreign_id");
  if (
    event.phone &&
    event.phone !== drop.campaignContact.contact.normalizedPhone
  ) {
    throw new Error("Webhook phone_number does not match foreign_id");
  }
  const status: DropStatus | null = event.dnc
    ? "OPTED_OUT"
    : mapDropStatus(event.eventType);
  const now =
    event.occurredAt && !Number.isNaN(event.occurredAt.getTime())
      ? event.occurredAt
      : new Date();
  if (drop.status !== "DRY_RUN") await ensureOutreachBillingPeriod(now);
  let result: {
    duplicate: boolean;
    eventId: string;
    appliedStatus: DropStatus | null;
  };
  try {
    result = await db.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "Drop"
        WHERE "id" = ${drop.id}::uuid
        FOR UPDATE
      `;
      const currentDrop = await tx.drop.findUniqueOrThrow({
        where: { id: drop.id },
        include: { campaignContact: { include: { contact: true } } },
      });
      const deliveryEvent = await tx.deliveryEvent.create({
        data: {
          dropId: drop.id,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          rawPayload: event.raw as Prisma.InputJsonValue,
          occurredAt: now,
        },
      });
      const applyProjection =
        status !== null &&
        shouldApplyDropStatusTransition(
          currentDrop.status,
          status,
          currentDrop.errorCode,
        );
      if (status && applyProjection) {
        await tx.drop.update({
          where: { id: drop.id },
          data: {
            status,
            deliveredAt: status === "DELIVERED" ? now : undefined,
            failedAt: status === "FAILED" ? now : undefined,
            optedOutAt:
              status === "OPTED_OUT"
                ? (currentDrop.optedOutAt ?? now)
                : undefined,
            errorMessage: status === "FAILED" ? event.reason : undefined,
          },
        });
        const campaignContactStatus =
          status === "DELIVERED"
            ? "DELIVERED"
            : status === "FAILED"
              ? "FAILED"
              : status === "OPTED_OUT"
                ? "OPTED_OUT"
                : status === "QUEUED"
                  ? "QUEUED"
                  : "SENDING";
        await tx.campaignContact.update({
          where: { id: drop.campaignContactId },
          data: { status: campaignContactStatus },
        });
      }
      if (
        applyProjection &&
        currentDrop.status !== "DRY_RUN" &&
        (status === "DELIVERED" || status === "FAILED")
      ) {
        await recordRvmDeliveryTx(tx, {
          campaignContactId: drop.campaignContactId,
          status,
          occurredAt: now,
          idempotencyKey: `delivery-event:${deliveryEvent.id}:${status.toLowerCase()}`,
          rawPayload: event.raw,
        });
        if (status === "DELIVERED") {
          const firstSuccess = await recordRvmSuccessUsageTx(tx, drop.id, now);
          if (firstSuccess) {
            const settings = await getAppSettings(tx);
            const usageValue = Math.round(
              settings.drop_cowboy_success_cost_cents,
            );
            await tx.drop.update({
              where: { id: drop.id },
              data: {
                providerUsageValueCents: usageValue,
                estimatedCostCents: usageValue,
              },
            });
          }
        }
      }
      if (applyProjection && status === "OPTED_OUT") {
        await applyCallbackOutcomeToSequencesTx(tx, {
          normalizedPhone: currentDrop.campaignContact.contact.normalizedPhone,
          outcome: "OPT_OUT",
          attributionChannel: "RVM_CALLBACK",
          occurredAt: now,
          idempotencyKey: `delivery-event:${deliveryEvent.id}:opt-out`,
          creditedCampaignContactId: drop.campaignContactId,
          rawPayload: event.raw,
          source: "dropcowboy_webhook",
        });
      }
      if (applyProjection && status === "OPTED_OUT") {
        const phone =
          event.phone ||
          (
            await tx.contact.findUnique({
              where: { id: currentDrop.campaignContact.contactId },
            })
          )?.normalizedPhone;
        if (phone) {
          await tx.suppressionEntry.upsert({
            where: { normalizedPhone: phone },
            create: {
              normalizedPhone: phone,
              contactId: currentDrop.campaignContact.contactId,
              reason: event.dnc ? "PROVIDER_DNC" : "OPT_OUT",
              source: "dropcowboy_webhook",
            },
            update: {
              reason: event.dnc ? "PROVIDER_DNC" : "OPT_OUT",
              source: "dropcowboy_webhook",
            },
          });
        }
      }
      return {
        duplicate: false,
        eventId: deliveryEvent.id,
        appliedStatus: applyProjection ? status : null,
      };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002"
    ) {
      const raced = await db.deliveryEvent.findUnique({
        where: { providerEventId: event.providerEventId },
      });
      if (raced) return { duplicate: true, eventId: raced.id };
    }
    throw error;
  }
  if (
    result.appliedStatus === "DELIVERED" ||
    result.appliedStatus === "FAILED" ||
    result.appliedStatus === "OPTED_OUT"
  ) {
    const active = await db.campaignContact.count({
      where: {
        campaignId: drop.campaignContact.campaignId,
        selectedForSend: true,
        status: { in: ["AUDIO_PENDING", "AUDIO_READY", "QUEUED", "SENDING"] },
      },
    });
    if (active === 0) {
      await db.campaign.updateMany({
        where: { id: drop.campaignContact.campaignId, status: "SENDING" },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
    }
  }
  return { duplicate: result.duplicate, eventId: result.eventId };
}
