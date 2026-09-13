import type { CampaignStatus } from "@prisma/client";

const transitions: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ["DATA_READY", "FAILED"],
  DATA_READY: ["PREVIEW_GENERATING", "FAILED"],
  PREVIEW_GENERATING: ["PREVIEW_READY", "FAILED"],
  PREVIEW_READY: ["APPROVED", "PREVIEW_GENERATING", "FAILED"],
  APPROVED: ["QUEUED", "PREVIEW_GENERATING", "FAILED"],
  QUEUED: ["SENDING", "PAUSED", "FAILED"],
  SENDING: ["PAUSED", "COMPLETED", "FAILED"],
  PAUSED: ["QUEUED", "SENDING", "FAILED"],
  COMPLETED: [],
  FAILED: ["DRAFT", "DATA_READY"],
};

export function canTransitionCampaign(
  from: CampaignStatus,
  to: CampaignStatus,
): boolean {
  return transitions[from].includes(to);
}

export function assertCampaignTransition(
  from: CampaignStatus,
  to: CampaignStatus,
): void {
  if (!canTransitionCampaign(from, to))
    throw new Error(`Invalid campaign transition: ${from} → ${to}`);
}
