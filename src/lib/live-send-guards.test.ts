import { beforeEach, describe, expect, it, vi } from "vitest";

const count = vi.fn();
const findUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { campaignContact: { count }, user: { findUnique } },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    RVM_LIVE_SENDS_ENABLED: true,
    MAX_LIVE_CAMPAIGN_SEND_LIMIT: 10,
    DROP_COWBOY_FORWARDING_NUMBER: "+12025550199",
  }),
}));

const assertReadyForLiveSend = vi.fn();
const rvm = {
  name: "dropcowboy",
  live: true,
  assertReadyForLiveSend,
  send: vi.fn(),
};
const valid = {
  campaign: {
    id: "campaign-1",
    status: "SENDING" as const,
    sendLimit: 10,
    approvedAt: new Date(),
    launchedAt: new Date(),
    launchedByUserId: "admin-1",
  },
  campaignContact: {
    id: "contact-1",
    selectedForSend: true,
    normalizedPhone: "+12025550101",
  },
  audio: {
    campaignContactId: "contact-1",
    status: "READY" as const,
    objectKey: "campaign/audio.mp3",
    contentType: "audio/mpeg",
    generatedAt: new Date(),
  },
  drop: { status: "PENDING" as const, queuedAt: null },
  callbackUrl: "https://drops.example/api/webhooks/dropcowboy",
  rvm,
};

describe("server-side live send guards", () => {
  beforeEach(() => {
    count.mockReset().mockResolvedValue(10);
    findUnique.mockReset().mockResolvedValue({ active: true, role: "ADMIN" });
    assertReadyForLiveSend.mockReset().mockResolvedValue(undefined);
  });

  it("accepts only a fully approved, bounded, valid send and verifies the brand", async () => {
    const { assertLiveSendPreconditions } = await import("./live-send-guards");
    await expect(assertLiveSendPreconditions(valid)).resolves.toBeUndefined();
    expect(assertReadyForLiveSend).toHaveBeenCalledOnce();
  });

  it("rejects a campaign over the live ceiling before provider access", async () => {
    const { assertLiveSendPreconditions } = await import("./live-send-guards");
    await expect(
      assertLiveSendPreconditions({
        ...valid,
        campaign: { ...valid.campaign, sendLimit: 11 },
      }),
    ).rejects.toThrow("live safety ceiling");
    expect(assertReadyForLiveSend).not.toHaveBeenCalled();
  });

  it("rejects any prior submission marker to prevent an ambiguous retry", async () => {
    const { assertLiveSendPreconditions } = await import("./live-send-guards");
    await expect(
      assertLiveSendPreconditions({
        ...valid,
        drop: { status: "FAILED", queuedAt: new Date() },
      }),
    ).rejects.toThrow("already has a submission attempt");
  });
});
