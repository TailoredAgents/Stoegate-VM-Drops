import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ensureOutreachBillingPeriod } from "@/lib/billing-economics";
import { getEnv } from "@/lib/env";
import { recordRvmSentTx } from "@/lib/outreach-service";
import { normalizeUSPhone } from "@/lib/phone";
import { getAppSettings } from "@/lib/settings";
import {
  getNextOperatingDayStart,
  getSendWindowAvailability,
  localDateStorageValue,
} from "@/lib/time";

type Tx = Prisma.TransactionClient;

export class RvmAttemptDeferredError extends Error {
  constructor(
    message: string,
    readonly nextAllowedAt: Date,
  ) {
    super(message);
    this.name = "RvmAttemptDeferredError";
  }
}

export async function reserveLiveRvmAttempt(input: {
  dropId: string;
  campaignContactId: string;
  audioAssetId: string;
  occurredAt?: Date;
}) {
  const occurredAt = input.occurredAt ?? new Date();
  const [settings, env] = await Promise.all([
    getAppSettings(),
    Promise.resolve(getEnv()),
  ]);
  const window = getSendWindowAvailability(
    occurredAt,
    settings.operations_timezone,
    settings.rvm_send_window_start,
    settings.rvm_send_window_end,
  );
  if (!window.allowed) {
    throw new RvmAttemptDeferredError(
      "Outside the configured live RVM send window",
      window.nextAllowedAt,
    );
  }
  const effectiveCap = Math.min(
    Math.trunc(settings.daily_rvm_cap),
    env.MAX_LIVE_DAILY_RVM_ATTEMPTS,
  );
  const localDate = localDateStorageValue(
    occurredAt,
    settings.operations_timezone,
  );
  await ensureOutreachBillingPeriod(occurredAt);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT d."id"
            FROM "Drop" d
            JOIN "CampaignContact" cc ON cc."id" = d."campaignContactId"
            JOIN "Campaign" c ON c."id" = cc."campaignId"
            JOIN "Contact" contact ON contact."id" = cc."contactId"
            JOIN "AudioAsset" audio ON audio."id" = d."audioAssetId"
            JOIN "OutreachSequence" sequence ON sequence."campaignContactId" = cc."id"
            JOIN "User" launch_admin ON launch_admin."id" = c."launchedByUserId"
            WHERE d."id" = ${input.dropId}::uuid
              AND cc."id" = ${input.campaignContactId}::uuid
              AND audio."id" = ${input.audioAssetId}::uuid
            FOR UPDATE OF d, cc, c, contact, audio, sequence, launch_admin
          `;
          if (locked.length !== 1)
            throw new Error(
              "Live RVM reservation does not match its campaign contact, audio, sequence, and launch admin",
            );

          const drop = await tx.drop.findUniqueOrThrow({
            where: { id: input.dropId },
            include: {
              audioAsset: true,
              campaignContact: {
                include: {
                  contact: true,
                  campaign: { include: { launchedBy: true } },
                },
              },
            },
          });
          const sequence = await tx.outreachSequence.findUniqueOrThrow({
            where: { campaignContactId: input.campaignContactId },
          });
          const prior = await tx.rvmUsageLedger.findUnique({
            where: { dropId_kind: { dropId: input.dropId, kind: "ATTEMPT" } },
          });
          if (prior)
            return {
              reserved: false as const,
              reason: "already_reserved" as const,
              effectiveCap,
            };

          const campaign = drop.campaignContact.campaign;
          const contact = drop.campaignContact.contact;
          const audio = drop.audioAsset;
          if (!env.RVM_LIVE_SENDS_ENABLED)
            throw new Error("Live RVM environment guard is disabled");
          if (
            campaign.status !== "SENDING" ||
            !campaign.approvedAt ||
            !campaign.launchedAt ||
            !campaign.launchedByUserId
          )
            throw new Error("Campaign is not approved and actively sending");
          if (
            !campaign.launchedBy ||
            !campaign.launchedBy.active ||
            campaign.launchedBy.role !== "ADMIN"
          )
            throw new Error("Campaign launch admin is no longer authorized");
          if (
            campaign.sendLimit < 1 ||
            campaign.sendLimit > env.MAX_LIVE_CAMPAIGN_SEND_LIMIT
          )
            throw new Error("Campaign exceeds the live campaign safety cap");
          if (
            !drop.campaignContact.selectedForSend ||
            drop.campaignContact.status !== "SENDING"
          )
            throw new Error("Campaign contact is not reserved for RVM sending");
          const selectedCount = await tx.campaignContact.count({
            where: {
              campaignId: campaign.id,
              selectedForSend: true,
            },
          });
          if (selectedCount > campaign.sendLimit)
            throw new Error("Selected contacts exceed the campaign send limit");
          if (
            normalizeUSPhone(contact.normalizedPhone) !==
            contact.normalizedPhone
          )
            throw new Error("Campaign contact phone is not normalized E.164");
          if (
            audio.campaignContactId !== input.campaignContactId ||
            audio.status !== "READY" ||
            audio.billingDisposition !== "BILLABLE_GENERATION" ||
            !audio.objectKey ||
            !audio.generatedAt ||
            !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(
              audio.contentType.toLowerCase().split(";", 1)[0],
            )
          )
            throw new Error("Campaign contact audio is not ready for live RVM");
          const storedGeneration = await tx.audioGenerationUsage.findFirst({
            where: {
              audioAssetId: audio.id,
              billingDisposition: "BILLABLE_GENERATION",
              storedAt: { not: null },
              storageError: null,
            },
            select: { id: true },
          });
          if (!storedGeneration)
            throw new Error(
              "Campaign contact has no verified stored live-audio generation",
            );
          if (sequence.currentState !== "RVM_PENDING" || sequence.terminalAt)
            throw new Error(
              `Outreach sequence blocks RVM submission (${sequence.currentState})`,
            );
          const suppression = await tx.suppressionEntry.findUnique({
            where: { normalizedPhone: contact.normalizedPhone },
            select: { id: true },
          });
          if (suppression)
            throw new Error("Campaign contact became suppressed before send");
          const knownLead = await tx.campaignContact.count({
            where: {
              contactId: contact.id,
              leadAttribution: { isNot: null },
            },
          });
          if (knownLead > 0)
            throw new Error("Campaign contact is already a known lead");
          if (drop.queuedAt || !["PENDING", "FAILED"].includes(drop.status))
            throw new Error("RVM submission was already reserved");

          const marked = await tx.drop.updateMany({
            where: {
              id: input.dropId,
              queuedAt: null,
              status: { in: ["PENDING", "FAILED"] },
            },
            data: {
              queuedAt: occurredAt,
              status: "PENDING",
              failedAt: null,
              errorCode: null,
              errorMessage: null,
            },
          });
          if (marked.count === 0)
            throw new Error("RVM submission was already reserved");

          const daily = await tx.rvmDailyUsage.upsert({
            where: {
              localDate_timezone: {
                localDate,
                timezone: settings.operations_timezone,
              },
            },
            create: {
              localDate,
              timezone: settings.operations_timezone,
              cap: effectiveCap,
            },
            update: { cap: effectiveCap },
          });
          const available = await tx.rvmDailyUsage.updateMany({
            where: { id: daily.id, attemptedCount: { lt: effectiveCap } },
            data: { attemptedCount: { increment: 1 }, cap: effectiveCap },
          });
          if (available.count === 0) {
            throw new RvmAttemptDeferredError(
              `Daily live RVM allowance of ${effectiveCap} has been reached`,
              getNextOperatingDayStart(
                occurredAt,
                settings.operations_timezone,
                settings.rvm_send_window_start,
              ),
            );
          }
          await tx.rvmUsageLedger.create({
            data: {
              dailyUsageId: daily.id,
              dropId: input.dropId,
              kind: "ATTEMPT",
              occurredAt,
            },
          });
          await recordRvmSentTx(tx, {
            campaignContactId: input.campaignContactId,
            occurredAt,
            idempotencyKey: `drop:${input.dropId}:submitted`,
          });
          return { reserved: true as const, effectiveCap };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        attempt < 4 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      )
        continue;
      throw error;
    }
  }
  throw new Error("Could not reserve daily RVM allowance");
}

export async function recordRvmSuccessUsageTx(
  tx: Tx,
  dropId: string,
  occurredAt: Date,
) {
  const settings = await getAppSettings(tx);
  const effectiveCap = Math.min(
    Math.trunc(settings.daily_rvm_cap),
    getEnv().MAX_LIVE_DAILY_RVM_ATTEMPTS,
  );
  const localDate = localDateStorageValue(
    occurredAt,
    settings.operations_timezone,
  );
  const daily = await tx.rvmDailyUsage.upsert({
    where: {
      localDate_timezone: {
        localDate,
        timezone: settings.operations_timezone,
      },
    },
    create: {
      localDate,
      timezone: settings.operations_timezone,
      cap: effectiveCap,
    },
    update: { cap: effectiveCap },
  });
  const inserted = await tx.rvmUsageLedger.createMany({
    data: [
      {
        dailyUsageId: daily.id,
        dropId,
        kind: "SUCCESS",
        occurredAt,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return false;
  await tx.rvmDailyUsage.update({
    where: { id: daily.id },
    data: { successfulCount: { increment: 1 } },
  });
  return true;
}

export async function getDailyRvmUsage(at = new Date()) {
  const settings = await getAppSettings();
  const localDate = localDateStorageValue(at, settings.operations_timezone);
  const usage = await db.rvmDailyUsage.findUnique({
    where: {
      localDate_timezone: {
        localDate,
        timezone: settings.operations_timezone,
      },
    },
  });
  const environmentCap = getEnv().MAX_LIVE_DAILY_RVM_ATTEMPTS;
  const operatingCap = Math.trunc(settings.daily_rvm_cap);
  const effectiveLiveCap = Math.min(operatingCap, environmentCap);
  return {
    timezone: settings.operations_timezone,
    localDate,
    operatingCap,
    environmentCap,
    effectiveLiveCap,
    attempted: usage?.attemptedCount ?? 0,
    successful: usage?.successfulCount ?? 0,
    remaining: Math.max(0, effectiveLiveCap - (usage?.attemptedCount ?? 0)),
  };
}
