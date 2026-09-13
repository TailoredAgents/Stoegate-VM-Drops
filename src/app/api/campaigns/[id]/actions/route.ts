import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { assertCampaignTransition } from "@/lib/campaign-state";
import { db } from "@/lib/db";
import { enqueuePrepareCampaign } from "@/jobs/queues";
import { assertSameOrigin } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";
import { getEnv } from "@/lib/env";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate_preview") }),
  z.object({ action: z.literal("approve") }),
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
    assertSameOrigin(request);
    const { id } = await params;
    const input = bodySchema.parse(await request.json());
    const campaign = await db.campaign.findUniqueOrThrow({ where: { id } });
    if (input.action === "generate_preview") {
      assertCampaignTransition(campaign.status, "PREVIEW_GENERATING");
      await enqueuePrepareCampaign(campaign.id, "preview");
      return Response.json({ status: "PREVIEW_GENERATING" }, { status: 202 });
    }
    if (input.action === "approve") {
      assertCampaignTransition(campaign.status, "APPROVED");
      await db.campaign.update({
        where: { id },
        data: { status: "APPROVED", approvedAt: new Date() },
      });
      return Response.json({ status: "APPROVED" });
    }
    if (input.action === "launch") {
      const env = getEnv();
      if (env.RVM_LIVE_SENDS_ENABLED && user.role !== "ADMIN")
        return jsonError("Only an admin can launch a live campaign", 403);
      if (input.confirmation !== `LAUNCH ${campaign.name}`)
        return jsonError(`Type LAUNCH ${campaign.name} to confirm`, 400);
      if (!input.acknowledgeLimit)
        return jsonError("Acknowledge the campaign send limit", 400);
      if (!campaign.approvedAt)
        return jsonError("Campaign preview approval is required", 400);
      if (
        env.RVM_LIVE_SENDS_ENABLED &&
        campaign.sendLimit > env.MAX_LIVE_CAMPAIGN_SEND_LIMIT
      ) {
        return jsonError(
          `Campaign send limit exceeds the live safety ceiling of ${env.MAX_LIVE_CAMPAIGN_SEND_LIMIT}`,
          400,
        );
      }
      assertCampaignTransition(campaign.status, "QUEUED");
      await db.campaign.update({
        where: { id },
        data: {
          status: "QUEUED",
          launchedAt: new Date(),
          launchedByUserId: user.id,
        },
      });
      await enqueuePrepareCampaign(campaign.id, "bulk");
      return Response.json(
        { status: "QUEUED", sendLimit: campaign.sendLimit },
        { status: 202 },
      );
    }
    if (input.action === "pause") {
      assertCampaignTransition(campaign.status, "PAUSED");
      await db.campaign.update({ where: { id }, data: { status: "PAUSED" } });
      return Response.json({ status: "PAUSED" });
    }
    assertCampaignTransition(campaign.status, "QUEUED");
    await db.campaign.update({ where: { id }, data: { status: "QUEUED" } });
    await enqueuePrepareCampaign(campaign.id, "bulk");
    return Response.json({ status: "QUEUED" }, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError(
      error instanceof Error ? error.message : "Campaign action failed",
      400,
    );
  }
}
