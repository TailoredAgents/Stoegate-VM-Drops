import type { AudioStatus, CampaignStatus, DropStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { normalizeUSPhone } from "@/lib/phone";
import type { RVMProvider } from "@/providers/types";

interface LiveSendGuardInput {
  campaign: {
    id: string;
    status: CampaignStatus;
    sendLimit: number;
    approvedAt: Date | null;
    launchedAt: Date | null;
    launchedByUserId: string | null;
  };
  campaignContact: {
    id: string;
    selectedForSend: boolean;
    normalizedPhone: string;
  };
  audio: {
    campaignContactId: string;
    status: AudioStatus;
    objectKey: string | null;
    contentType: string;
    generatedAt: Date | null;
  };
  drop: { status: DropStatus; queuedAt: Date | null };
  callbackUrl: string;
  rvm: RVMProvider;
}

export async function assertLiveSendPreconditions(
  input: LiveSendGuardInput,
): Promise<void> {
  if (!input.rvm.live) return;
  const env = getEnv();
  if (!env.RVM_LIVE_SENDS_ENABLED)
    throw new Error(
      "Live RVM provider cannot run while its environment guard is disabled",
    );
  if (
    input.campaign.status !== "SENDING" ||
    !input.campaign.approvedAt ||
    !input.campaign.launchedAt ||
    !input.campaign.launchedByUserId
  ) {
    throw new Error(
      "Campaign has not completed the approved and confirmed launch flow",
    );
  }
  const launchAdmin = await db.user.findUnique({
    where: { id: input.campaign.launchedByUserId },
    select: { active: true, role: true },
  });
  if (!launchAdmin?.active || launchAdmin.role !== "ADMIN") {
    throw new Error(
      "Live campaign launch was not authorized by an active admin",
    );
  }
  if (
    input.campaign.sendLimit < 1 ||
    input.campaign.sendLimit > env.MAX_LIVE_CAMPAIGN_SEND_LIMIT
  ) {
    throw new Error(
      `Campaign send limit exceeds the live safety ceiling of ${env.MAX_LIVE_CAMPAIGN_SEND_LIMIT}`,
    );
  }
  if (!input.campaignContact.selectedForSend)
    throw new Error("Contact was not selected within the campaign send limit");
  const selectedCount = await db.campaignContact.count({
    where: { campaignId: input.campaign.id, selectedForSend: true },
  });
  if (selectedCount > input.campaign.sendLimit)
    throw new Error("Selected contacts exceed the campaign send limit");
  if (
    normalizeUSPhone(input.campaignContact.normalizedPhone) !==
    input.campaignContact.normalizedPhone
  ) {
    throw new Error("Contact phone is not a valid normalized US E.164 number");
  }
  if (
    input.audio.campaignContactId !== input.campaignContact.id ||
    input.audio.status !== "READY" ||
    !input.audio.objectKey ||
    !input.audio.generatedAt ||
    !["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav"].includes(
      input.audio.contentType.toLowerCase().split(";", 1)[0],
    )
  ) {
    throw new Error(
      "Approved generated audio is not ready for this campaign contact",
    );
  }
  if (
    input.drop.queuedAt ||
    ["QUEUED", "SENT", "DELIVERED", "OPTED_OUT", "DRY_RUN"].includes(
      input.drop.status,
    )
  ) {
    throw new Error(
      "This drop already has a submission attempt or successful result",
    );
  }
  const callback = new URL(input.callbackUrl);
  if (
    callback.protocol !== "https:" ||
    callback.pathname !== "/api/webhooks/dropcowboy"
  ) {
    throw new Error(
      "Live callback URL must be the HTTPS Drop Cowboy webhook endpoint",
    );
  }
  if (
    normalizeUSPhone(env.DROP_COWBOY_FORWARDING_NUMBER ?? "") !==
    env.DROP_COWBOY_FORWARDING_NUMBER
  ) {
    throw new Error("Drop Cowboy forwarding number is not valid E.164");
  }
  await input.rvm.assertReadyForLiveSend();
}
