import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { assertCampaignTransition } from "@/lib/campaign-state";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { enqueuePrepareCampaign } from "@/jobs/queues";
import { assertSameOrigin } from "@/lib/request-security";
import {
  lockSmsCampaignDispatchTx,
  lockSmsProviderReadinessSharedTx,
} from "@/lib/sms-dispatch-lock";
import {
  assertFreshTwilioReadiness,
  TwilioReadinessError,
} from "@/lib/twilio-readiness";
import { jsonError } from "@/lib/utils";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate_preview") }),
  z.object({
    action: z.literal("approve"),
    acknowledgeReadiness: z.boolean(),
  }),
  z.object({
    action: z.literal("launch"),
    confirmation: z.string(),
    acknowledgeLimit: z.boolean(),
  }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireApiUser();
    if (user.role !== "ADMIN") return jsonError("Admin access required", 403);
    assertSameOrigin(request);
    const { id } = await params;
    const input = bodySchema.parse(await request.json());
    const campaign = await db.campaign.findUniqueOrThrow({
      where: { id },
      include: { smsTemplateVersion: true },
    });
    if (campaign.kind !== "SMS")
      return jsonError("Archived legacy campaigns are read-only", 409);

    if (input.action === "generate_preview") {
      assertCampaignTransition(campaign.status, "PREVIEW_GENERATING");
      await enqueuePrepareCampaign(campaign.id, "preview");
      return Response.json({ status: "PREVIEW_GENERATING" }, { status: 202 });
    }

    if (input.action === "approve") {
      if (!input.acknowledgeReadiness)
        return jsonError("Acknowledge the operational readiness review", 400);
      if (!campaign.smsTemplateVersion)
        return jsonError("An SMS template version is required", 400);
      if (campaign.smsTemplateVersion.status !== "APPROVED")
        return jsonError(
          "The selected SMS template version is not approved",
          400,
        );
      assertCampaignTransition(campaign.status, "APPROVED");
      const now = new Date();
      await db.$transaction([
        db.campaign.update({
          where: { id },
          data: {
            status: "APPROVED",
            approvedAt: now,
            approvedByUserId: user.id,
            smsComplianceStatus: "APPROVED",
          },
        }),
        db.smsAuditEvent.create({
          data: {
            eventType: "CAMPAIGN_APPROVED",
            entityType: "Campaign",
            entityId: id,
            campaignId: id,
            actorUserId: user.id,
            idempotencyKey: "sms-campaign:" + id + ":approved",
            source: "campaign_ui",
            occurredAt: now,
            metadata: {
              operationalReadinessReviewed: true,
              legalComplianceDetermination: false,
            },
          },
        }),
      ]);
      return Response.json({ status: "APPROVED" });
    }

    if (input.action === "launch") {
      const env = getEnv();
      if (input.confirmation !== "LAUNCH " + campaign.name)
        return jsonError("Type LAUNCH " + campaign.name + " to confirm", 400);
      if (!input.acknowledgeLimit)
        return jsonError("Acknowledge the campaign send limits", 400);
      if (!campaign.approvedAt || !campaign.approvedByUserId)
        return jsonError("Campaign preview approval is required", 400);
      const now = new Date();
      const launched = await db.$transaction(
        async (tx) => {
          if (env.SMS_LIVE_SENDS_ENABLED)
            await lockSmsProviderReadinessSharedTx(tx, "twilio");
          await lockSmsCampaignDispatchTx(tx, id);
          const current = await tx.campaign.findUniqueOrThrow({
            where: { id },
            include: { smsTemplateVersion: true },
          });
          if (current.kind !== "SMS")
            throw new Error("Archived legacy campaigns are read-only");
          if (input.confirmation !== "LAUNCH " + current.name)
            throw new Error("Campaign name changed; confirm launch again");
          if (!current.approvedAt || !current.approvedByUserId)
            throw new Error("Campaign preview approval is required");

          if (env.SMS_LIVE_SENDS_ENABLED) {
            if (env.SMS_PROVIDER.toLowerCase() !== "twilio")
              throw new TwilioReadinessError(
                "NOT_READY",
                "Twilio is not selected as the production provider",
              );
            if (
              current.smsProviderKey?.toLowerCase() !== "twilio" ||
              !env.TWILIO_MESSAGING_SERVICE_SID ||
              current.smsSenderRef !== env.TWILIO_MESSAGING_SERVICE_SID
            )
              throw new TwilioReadinessError(
                "NOT_READY",
                "Campaign Messaging Service does not match the approved Twilio configuration",
              );
            await assertFreshTwilioReadiness({ client: tx, env, now });
            if (current.sendLimit > env.MAX_LIVE_SMS_CAMPAIGN_LIMIT)
              throw new Error(
                "Campaign total cap exceeds the live ceiling of " +
                  env.MAX_LIVE_SMS_CAMPAIGN_LIMIT,
              );
            if (current.smsDailyCap > env.MAX_LIVE_DAILY_SMS_LIMIT)
              throw new Error(
                "Campaign daily cap exceeds the live ceiling of " +
                  env.MAX_LIVE_DAILY_SMS_LIMIT,
              );
          }

          const future = Boolean(
            current.smsScheduledFor &&
            current.smsScheduledFor.getTime() > now.getTime(),
          );
          const nextStatus = future ? "SCHEDULED" : "QUEUED";
          assertCampaignTransition(current.status, nextStatus);
          await tx.campaign.update({
            where: { id },
            data: {
              status: nextStatus,
              launchedAt: now,
              launchedByUserId: user.id,
            },
          });
          await tx.smsAuditEvent.create({
            data: {
              eventType: future ? "CAMPAIGN_SCHEDULED" : "CAMPAIGN_LAUNCHED",
              entityType: "Campaign",
              entityId: id,
              campaignId: id,
              actorUserId: user.id,
              idempotencyKey: "sms-campaign:" + id + ":launch",
              source: "campaign_ui",
              occurredAt: now,
              metadata: {
                liveSms: env.SMS_LIVE_SENDS_ENABLED,
                provider: env.SMS_PROVIDER,
                totalCap: current.sendLimit,
                dailyCap: current.smsDailyCap,
                scheduledFor: current.smsScheduledFor?.toISOString() ?? null,
              },
            },
          });
          return {
            future,
            nextStatus,
            sendLimit: current.sendLimit,
            scheduledFor: current.smsScheduledFor,
          };
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
      await enqueuePrepareCampaign(
        id,
        "bulk",
        launched.future ? launched.scheduledFor! : undefined,
      );
      return Response.json(
        { status: launched.nextStatus, sendLimit: launched.sendLimit },
        { status: 202 },
      );
    }

    if (input.action === "pause") {
      await db.$transaction(
        async (tx) => {
          await lockSmsCampaignDispatchTx(tx, id);
          const current = await tx.campaign.findUniqueOrThrow({
            where: { id },
          });
          if (current.kind !== "SMS")
            throw new Error("Archived legacy campaigns are read-only");
          assertCampaignTransition(current.status, "PAUSED");
          await tx.campaign.update({
            where: { id },
            data: { status: "PAUSED", pausedAt: new Date() },
          });
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
      return Response.json({ status: "PAUSED" });
    }

    const future =
      campaign.smsScheduledFor && campaign.smsScheduledFor > new Date();
    const nextStatus = future ? "SCHEDULED" : "QUEUED";
    assertCampaignTransition(campaign.status, nextStatus);
    await db.campaign.update({
      where: { id },
      data: { status: nextStatus, pausedAt: null },
    });
    await enqueuePrepareCampaign(
      campaign.id,
      "bulk",
      future ? campaign.smsScheduledFor! : undefined,
    );
    return Response.json({ status: nextStatus }, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    if (error instanceof TwilioReadinessError)
      return jsonError(error.message, 503);
    return jsonError(error instanceof Error ? error.message : "Action failed");
  }
}
