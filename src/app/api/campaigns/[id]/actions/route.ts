import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { assertCampaignTransition } from "@/lib/campaign-state";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { enqueuePrepareCampaign } from "@/jobs/queues";
import { assertSameOrigin } from "@/lib/request-security";
import { lockSmsCampaignDispatchTx } from "@/lib/sms-dispatch-lock";
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
      if (env.SMS_LIVE_SENDS_ENABLED) {
        if (env.SMS_PROVIDER.toLowerCase() === "dry-run")
          return jsonError("A production SMS provider is not selected", 503);
        if (campaign.sendLimit > env.MAX_LIVE_SMS_CAMPAIGN_LIMIT)
          return jsonError(
            "Campaign total cap exceeds the live ceiling of " +
              env.MAX_LIVE_SMS_CAMPAIGN_LIMIT,
            400,
          );
        if (campaign.smsDailyCap > env.MAX_LIVE_DAILY_SMS_LIMIT)
          return jsonError(
            "Campaign daily cap exceeds the live ceiling of " +
              env.MAX_LIVE_DAILY_SMS_LIMIT,
            400,
          );
      }
      const now = new Date();
      const future =
        campaign.smsScheduledFor &&
        campaign.smsScheduledFor.getTime() > now.getTime();
      const nextStatus = future ? "SCHEDULED" : "QUEUED";
      assertCampaignTransition(campaign.status, nextStatus);
      await db.$transaction([
        db.campaign.update({
          where: { id },
          data: {
            status: nextStatus,
            launchedAt: now,
            launchedByUserId: user.id,
          },
        }),
        db.smsAuditEvent.create({
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
              totalCap: campaign.sendLimit,
              dailyCap: campaign.smsDailyCap,
              scheduledFor: campaign.smsScheduledFor?.toISOString() ?? null,
            },
          },
        }),
      ]);
      await enqueuePrepareCampaign(
        campaign.id,
        "bulk",
        future ? campaign.smsScheduledFor! : undefined,
      );
      return Response.json(
        { status: nextStatus, sendLimit: campaign.sendLimit },
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
    return jsonError(error instanceof Error ? error.message : "Action failed");
  }
}
