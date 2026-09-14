import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBillingPeriod: vi.fn(),
  getAppSettings: vi.fn(),
  getEnv: vi.fn(),
  recordRvmSentTx: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/billing-economics", () => ({
  ensureOutreachBillingPeriod: mocks.ensureBillingPeriod,
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/outreach-service", () => ({
  recordRvmSentTx: mocks.recordRvmSentTx,
}));
vi.mock("@/lib/settings", () => ({ getAppSettings: mocks.getAppSettings }));
vi.mock("@/lib/time", () => ({
  getNextOperatingDayStart: vi.fn(() => new Date("2026-09-16T12:00:00.000Z")),
  getSendWindowAvailability: vi.fn(() => ({ allowed: true })),
  localDateStorageValue: vi.fn(() => new Date("2026-09-15T00:00:00.000Z")),
}));

import { reserveLiveRvmAttempt } from "./rvm-operations";

function validDrop() {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    campaignContactId: "20000000-0000-4000-8000-000000000002",
    audioAssetId: "30000000-0000-4000-8000-000000000003",
    status: "PENDING",
    queuedAt: null,
    audioAsset: {
      id: "30000000-0000-4000-8000-000000000003",
      campaignContactId: "20000000-0000-4000-8000-000000000002",
      status: "READY",
      objectKey: "audio.mp3",
      generatedAt: new Date("2026-09-15T10:00:00.000Z"),
      contentType: "audio/mpeg",
      billingDisposition: "BILLABLE_GENERATION" as const,
    },
    campaignContact: {
      id: "20000000-0000-4000-8000-000000000002",
      status: "SENDING",
      selectedForSend: true,
      contact: {
        id: "70000000-0000-4000-8000-000000000007",
        normalizedPhone: "+12025550123",
      },
      campaign: {
        id: "40000000-0000-4000-8000-000000000004",
        status: "SENDING",
        sendLimit: 10,
        approvedAt: new Date("2026-09-15T09:00:00.000Z"),
        launchedAt: new Date("2026-09-15T09:30:00.000Z"),
        launchedByUserId: "50000000-0000-4000-8000-000000000005",
        launchedBy: { active: true, role: "ADMIN" },
      },
    },
  };
}

describe("live RVM reservation safety", () => {
  let drop: ReturnType<typeof validDrop>;
  let sequence: {
    id: string;
    currentState: string;
    terminalAt: Date | null;
  };
  let prior: object | null;
  let tx: Record<string, unknown>;
  let markDrop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    drop = validDrop();
    sequence = {
      id: "60000000-0000-4000-8000-000000000006",
      currentState: "RVM_PENDING",
      terminalAt: null,
    };
    prior = null;
    markDrop = vi.fn();
    tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: drop.id }]),
      drop: {
        findUniqueOrThrow: vi.fn(async () => drop),
        updateMany: markDrop,
      },
      outreachSequence: {
        findUniqueOrThrow: vi.fn(async () => sequence),
      },
      audioGenerationUsage: {
        findFirst: vi.fn().mockResolvedValue({ id: "stored-generation" }),
      },
      rvmUsageLedger: {
        findUnique: vi.fn(async () => prior),
        create: vi.fn(),
      },
      campaignContact: {
        count: vi.fn(async ({ where }: { where: { contactId?: string } }) =>
          where.contactId ? 0 : 1,
        ),
      },
      suppressionEntry: { findUnique: vi.fn().mockResolvedValue(null) },
      rvmDailyUsage: { upsert: vi.fn(), updateMany: vi.fn() },
    };
    mocks.transaction.mockImplementation(
      async (callback: (value: typeof tx) => unknown) => callback(tx),
    );
    mocks.getEnv.mockReturnValue({
      RVM_LIVE_SENDS_ENABLED: true,
      MAX_LIVE_CAMPAIGN_SEND_LIMIT: 10,
      MAX_LIVE_DAILY_RVM_ATTEMPTS: 10,
    });
    mocks.getAppSettings.mockResolvedValue({
      operations_timezone: "America/New_York",
      rvm_send_window_start: "08:00",
      rvm_send_window_end: "21:00",
      daily_rvm_cap: 10,
    });
  });

  it("returns reserved false and performs no new mutation for an existing reservation", async () => {
    prior = { id: "already-reserved" };
    const result = await reserveLiveRvmAttempt({
      dropId: drop.id,
      campaignContactId: drop.campaignContactId,
      audioAssetId: drop.audioAssetId,
    });

    expect(result).toMatchObject({
      reserved: false,
      reason: "already_reserved",
    });
    expect(markDrop).not.toHaveBeenCalled();
    expect(mocks.recordRvmSentTx).not.toHaveBeenCalled();
  });

  it.each([
    ["a callback-terminal sequence", "RVM_CALLBACK", new Date()],
    ["a paused campaign", "RVM_PENDING", null],
  ])("blocks %s at the transactional boundary", async (_label, state, end) => {
    sequence.currentState = state;
    sequence.terminalAt = end;
    if (_label === "a paused campaign")
      drop.campaignContact.campaign.status = "PAUSED";

    await expect(
      reserveLiveRvmAttempt({
        dropId: drop.id,
        campaignContactId: drop.campaignContactId,
        audioAssetId: drop.audioAssetId,
      }),
    ).rejects.toThrow(/sequence blocks|actively sending/);
    expect(markDrop).not.toHaveBeenCalled();
    expect(mocks.recordRvmSentTx).not.toHaveBeenCalled();
  });

  it("blocks a contact already attributed as a lead in another campaign", async () => {
    const count = (tx.campaignContact as { count: ReturnType<typeof vi.fn> })
      .count;
    count.mockImplementation(
      async ({ where }: { where: { contactId?: string } }) =>
        where.contactId ? 1 : 1,
    );

    await expect(
      reserveLiveRvmAttempt({
        dropId: drop.id,
        campaignContactId: drop.campaignContactId,
        audioAssetId: drop.audioAssetId,
      }),
    ).rejects.toThrow(/already a known lead/i);
    expect(markDrop).not.toHaveBeenCalled();
    expect(mocks.recordRvmSentTx).not.toHaveBeenCalled();
  });
});
