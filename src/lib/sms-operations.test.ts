import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  getEnv: vi.fn(),
  getAppSettings: vi.fn(),
  getBusinessSendWindowAvailability: vi.fn(),
  getLocalDayBounds: vi.fn(),
  getNextBusinessDayStart: vi.fn(),
  localDateKey: vi.fn(),
  localDateStorageValue: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction } }));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/settings", () => ({
  getAppSettings: mocks.getAppSettings,
}));
vi.mock("@/lib/time", () => ({
  getBusinessSendWindowAvailability: mocks.getBusinessSendWindowAvailability,
  getLocalDayBounds: mocks.getLocalDayBounds,
  getNextBusinessDayStart: mocks.getNextBusinessDayStart,
  localDateKey: mocks.localDateKey,
  localDateStorageValue: mocks.localDateStorageValue,
}));

import {
  persistDryRunSmsResult,
  persistLiveSmsProviderResult,
  persistSmsDeliveryStatus,
  reserveLiveSmsAttempt,
  SmsAttemptDeferredError,
} from "./sms-operations";

const NOW = new Date("2026-09-15T15:00:00.000Z");
const NEXT_BUSINESS_DAY = new Date("2026-09-16T13:00:00.000Z");
const LOCAL_DATE = new Date("2026-09-15T00:00:00.000Z");

function hash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validMessage() {
  const renderedBody = "Hi Sam, are you interested in 1 Main St?";
  return {
    id: "10000000-0000-4000-8000-000000000001",
    campaignContactId: "20000000-0000-4000-8000-000000000002",
    sequenceId: "30000000-0000-4000-8000-000000000003",
    templateVersionId: "40000000-0000-4000-8000-000000000004",
    consentEvidenceId: "50000000-0000-4000-8000-000000000005",
    idempotencyKey: "message-idempotency-key",
    toPhone: "+12025550123",
    fromPhone: "+12025550999" as string | null,
    renderedBody,
    bodyHash: hash(renderedBody),
    segmentCount: 1,
    actualSegmentCount: null,
    estimatedCostMicros: 800,
    actualCostMicros: null,
    currency: "USD",
    providerKey: null as string | null,
    providerMessageId: null as string | null,
    providerStatus: null as string | null,
    status: "QUEUED" as string,
    scheduledFor: null as Date | null,
    acceptedAt: null as Date | null,
    sentAt: null as Date | null,
    campaignContact: {
      id: "20000000-0000-4000-8000-000000000002",
      status: "QUEUED",
      selectedForSend: true,
      contact: {
        id: "60000000-0000-4000-8000-000000000006",
        normalizedPhone: "+12025550123",
      },
      campaign: {
        id: "70000000-0000-4000-8000-000000000007",
        kind: "SMS",
        status: "SENDING",
        sendLimit: 10,
        smsDailyCap: 5,
        smsComplianceStatus: "APPROVED",
        smsProviderKey: "provider-x",
        smsSenderRef: "+12025550999" as string | null,
        smsTemplateVersionId: "40000000-0000-4000-8000-000000000004",
        smsScheduleTimezone: "America/Chicago",
        smsScheduledFor: null as Date | null,
        smsSendWindowStartMinutes: 9 * 60,
        smsSendWindowEndMinutes: 20 * 60,
        smsColdCallDelayHours: 48,
        approvedAt: new Date("2026-09-14T12:00:00.000Z"),
        approvedByUserId: "80000000-0000-4000-8000-000000000008",
        launchedAt: new Date("2026-09-15T13:00:00.000Z"),
        launchedByUserId: "90000000-0000-4000-8000-000000000009",
        approvedBy: { active: true, role: "ADMIN" },
        launchedBy: { active: true, role: "ADMIN" },
      },
    },
    sequence: {
      id: "30000000-0000-4000-8000-000000000003",
      campaignContactId: "20000000-0000-4000-8000-000000000002",
      currentState: "SMS_QUEUED",
      smsScheduledFor: null as Date | null,
      smsSentAt: null as Date | null,
      coldCallDueAt: null as Date | null,
      nextEligibleAt: null as Date | null,
      terminalAt: null as Date | null,
    },
    templateVersion: {
      id: "40000000-0000-4000-8000-000000000004",
      status: "APPROVED",
      approvedAt: new Date("2026-09-14T12:00:00.000Z"),
      approvedByUserId: "80000000-0000-4000-8000-000000000008",
      approvedBy: { active: true, role: "ADMIN" },
      template: { active: true },
    },
    consentEvidence: {
      id: "50000000-0000-4000-8000-000000000005",
      contactId: "60000000-0000-4000-8000-000000000006",
      campaignId: "70000000-0000-4000-8000-000000000007",
      campaignContactId: "20000000-0000-4000-8000-000000000002",
      normalizedPhone: "+12025550123",
      status: "VERIFIED",
      basis: "EXPRESS_WRITTEN",
      capturedAt: new Date("2026-09-01T12:00:00.000Z"),
      expiresAt: null as Date | null,
      revokedAt: null as Date | null,
    },
  };
}

function makeTx(message: ReturnType<typeof validMessage>) {
  const attempt = {
    id: "a0000000-0000-4000-8000-00000000000a",
    messageId: message.id,
    attemptNumber: 1,
    providerKey: "provider-x",
    providerRequestId: null,
    providerMessageId: null as string | null,
    status: "STARTED" as string,
  };
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: message.id }]),
    smsOutboundMessage: {
      findUniqueOrThrow: vi.fn(async () => message),
      findUnique: vi.fn(async () => message),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    smsOutboundAttempt: {
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(async () => attempt),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: attempt.id }),
      update: vi.fn(),
    },
    smsUsageLedger: {
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    smsDailyUsage: {
      upsert: vi.fn().mockResolvedValue({
        id: "b0000000-0000-4000-8000-00000000000b",
        attemptedCount: 2,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    campaignContact: {
      count: vi.fn().mockResolvedValue(5),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    outreachSequence: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn(),
    },
    suppressionEntry: { findUnique: vi.fn().mockResolvedValue(null) },
    campaignSuppression: { findUnique: vi.fn().mockResolvedValue(null) },
    leadAttribution: { findFirst: vi.fn().mockResolvedValue(null) },
    outreachEvent: { create: vi.fn() },
    smsAuditEvent: { create: vi.fn() },
    smsStatusEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
  };
}

describe("atomic live SMS reservation", () => {
  let message: ReturnType<typeof validMessage>;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    message = validMessage();
    tx = makeTx(message);
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    mocks.getEnv.mockReturnValue({
      SMS_LIVE_SENDS_ENABLED: true,
      SMS_PROVIDER: "provider-x",
      MAX_LIVE_SMS_CAMPAIGN_LIMIT: 10,
      MAX_LIVE_DAILY_SMS_LIMIT: 10,
    });
    mocks.getAppSettings.mockResolvedValue({
      daily_sms_cap: 8,
      operations_timezone: "America/New_York",
      sms_send_window_start: "09:00",
      sms_send_window_end: "20:00",
    });
    mocks.getBusinessSendWindowAvailability.mockReturnValue({ allowed: true });
    mocks.getLocalDayBounds.mockReturnValue({
      start: new Date("2026-09-15T05:00:00.000Z"),
      end: new Date("2026-09-16T05:00:00.000Z"),
      key: "2026-09-15",
    });
    mocks.getNextBusinessDayStart.mockReturnValue(NEXT_BUSINESS_DAY);
    mocks.localDateKey.mockReturnValue("2026-09-15");
    mocks.localDateStorageValue.mockReturnValue(LOCAL_DATE);
  });

  it("reserves attempt one and all submitting state in one transaction", async () => {
    const result = await reserveLiveSmsAttempt({
      messageId: message.id,
      occurredAt: NOW,
    });

    expect(result).toMatchObject({
      reserved: true,
      attemptNumber: 1,
      providerKey: "provider-x",
      message: {
        toPhone: message.toPhone,
        renderedBody: message.renderedBody,
      },
      caps: {
        campaignTotalUsed: 1,
        campaignDailyUsed: 1,
        globalDailyUsed: 3,
        timezone: "America/New_York",
        campaignTimezone: "America/Chicago",
      },
    });
    expect(tx.smsOutboundAttempt.create).toHaveBeenCalledTimes(1);
    expect(tx.smsUsageLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: "ATTEMPT", messageId: message.id }),
    });
    expect(tx.smsDailyUsage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ attemptedCount: { increment: 1 } }),
      }),
    );
    expect(tx.smsOutboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUBMITTING" }),
      }),
    );
    expect(tx.campaignContact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENDING" }),
      }),
    );
    expect(tx.outreachSequence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentState: "SMS_SENDING" }),
      }),
    );
    expect(tx.outreachEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "SMS_SUBMISSION_STARTED" }),
      }),
    );
    expect(tx.smsAuditEvent.create).toHaveBeenCalledTimes(1);
  });

  it("persists the exact campaign sender before returning a live reservation", async () => {
    message.fromPhone = null;

    const result = await reserveLiveSmsAttempt({
      messageId: message.id,
      occurredAt: NOW,
    });

    expect(result).toMatchObject({
      reserved: true,
      message: { fromPhone: "+12025550999" },
    });
    expect(tx.smsOutboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromPhone: "+12025550999" }),
      }),
    );
    expect(tx.smsOutboundAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestPayload: expect.objectContaining({ from: "+12025550999" }),
        }),
      }),
    );
  });

  it.each([
    { messageSender: null, campaignSender: null },
    { messageSender: null, campaignSender: "202-555-0999" },
    { messageSender: "+12025550888", campaignSender: "+12025550999" },
  ])(
    "fails closed for an absent, noncanonical, or conflicting sender: $campaignSender",
    async ({ messageSender, campaignSender }) => {
      message.fromPhone = messageSender;
      message.campaignContact.campaign.smsSenderRef = campaignSender;

      await expect(
        reserveLiveSmsAttempt({ messageId: message.id, occurredAt: NOW }),
      ).rejects.toThrow(/originating SMS phone number/i);
      expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
    },
  );

  it.each(["STARTED", "UNKNOWN"])(
    "returns already-reserved for an existing %s attempt and creates nothing",
    async (status) => {
      tx.smsOutboundAttempt.findUnique.mockResolvedValue({
        id: "existing-attempt",
        status,
      } as never);

      const result = await reserveLiveSmsAttempt({
        messageId: message.id,
        occurredAt: NOW,
      });

      expect(result).toMatchObject({
        reserved: false,
        reason: "already_reserved",
        attemptStatus: status,
      });
      expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
      expect(tx.smsDailyUsage.updateMany).not.toHaveBeenCalled();
      expect(tx.outreachEvent.create).not.toHaveBeenCalled();
    },
  );

  it("rechecks suppressions and known-lead state inside the transaction", async () => {
    tx.campaignSuppression.findUnique.mockResolvedValue({ id: "new-block" });

    await expect(
      reserveLiveSmsAttempt({ messageId: message.id, occurredAt: NOW }),
    ).rejects.toThrow(/became suppressed/i);
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();

    tx.campaignSuppression.findUnique.mockResolvedValue(null);
    tx.leadAttribution.findFirst.mockResolvedValue({ id: "known-lead" });
    await expect(
      reserveLiveSmsAttempt({ messageId: message.id, occurredAt: NOW }),
    ).rejects.toThrow(/known lead/i);
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
  });

  it("rechecks active approval and launch admins", async () => {
    message.campaignContact.campaign.launchedBy.active = false;

    await expect(
      reserveLiveSmsAttempt({ messageId: message.id, occurredAt: NOW }),
    ).rejects.toThrow(/admin is no longer authorized/i);
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
  });

  it("returns a typed send-window deferral with nextAllowedAt", async () => {
    mocks.getBusinessSendWindowAvailability.mockReturnValue({
      allowed: false,
      nextAllowedAt: NEXT_BUSINESS_DAY,
    });

    const error = await reserveLiveSmsAttempt({
      messageId: message.id,
      occurredAt: NOW,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SmsAttemptDeferredError);
    expect(error).toMatchObject({
      reason: "OUTSIDE_BUSINESS_SEND_WINDOW",
      nextAllowedAt: NEXT_BUSINESS_DAY,
    });
    expect(mocks.getBusinessSendWindowAvailability).toHaveBeenCalledWith(
      NOW,
      "America/Chicago",
      "09:00",
      "20:00",
    );
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
  });

  it("defers a future schedule and adjusts it to the next business window", async () => {
    const scheduledFor = new Date("2026-09-19T16:00:00.000Z");
    message.scheduledFor = scheduledFor;
    mocks.getBusinessSendWindowAvailability.mockReturnValue({
      allowed: false,
      nextAllowedAt: NEXT_BUSINESS_DAY,
    });

    const error = await reserveLiveSmsAttempt({
      messageId: message.id,
      occurredAt: NOW,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      reason: "NOT_YET_SCHEDULED",
      nextAllowedAt: NEXT_BUSINESS_DAY,
    });
    expect(mocks.getBusinessSendWindowAvailability).toHaveBeenCalledWith(
      scheduledFor,
      "America/Chicago",
      "09:00",
      "20:00",
    );
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
  });

  it("enforces campaign daily and global daily attempt caps", async () => {
    tx.smsUsageLedger.count.mockResolvedValueOnce(3).mockResolvedValueOnce(5);
    let error = await reserveLiveSmsAttempt({
      messageId: message.id,
      occurredAt: NOW,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      reason: "CAMPAIGN_DAILY_CAP_REACHED",
      nextAllowedAt: NEXT_BUSINESS_DAY,
    });
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();

    tx.smsUsageLedger.count.mockReset().mockResolvedValue(0);
    tx.smsDailyUsage.updateMany.mockResolvedValue({ count: 0 });
    error = await reserveLiveSmsAttempt({
      messageId: message.id,
      occurredAt: NOW,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "GLOBAL_DAILY_CAP_REACHED" });
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
  });

  it("enforces the campaign's lifetime attempt cap", async () => {
    tx.smsUsageLedger.count
      .mockResolvedValueOnce(message.campaignContact.campaign.sendLimit)
      .mockResolvedValueOnce(0);

    await expect(
      reserveLiveSmsAttempt({ messageId: message.id, occurredAt: NOW }),
    ).rejects.toThrow(/campaign total SMS cap/i);
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
    expect(tx.smsUsageLedger.create).not.toHaveBeenCalled();
  });
});

describe("live SMS result and delivery persistence", () => {
  let message: ReturnType<typeof validMessage>;
  let tx: ReturnType<typeof makeTx>;

  beforeEach(() => {
    vi.clearAllMocks();
    message = validMessage();
    message.status = "SUBMITTING";
    message.providerKey = "provider-x";
    message.campaignContact.status = "SENDING";
    message.sequence.currentState = "SMS_SENDING";
    tx = makeTx(message);
    tx.smsOutboundAttempt.findUnique.mockResolvedValue({
      id: "a0000000-0000-4000-8000-00000000000a",
      messageId: message.id,
      attemptNumber: 1,
      providerKey: "provider-x",
      providerMessageId: null,
      status: "STARTED",
    } as never);
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );
    mocks.getEnv.mockReturnValue({ MAX_LIVE_DAILY_SMS_LIMIT: 10 });
    mocks.getAppSettings.mockResolvedValue({
      daily_sms_cap: 8,
      operations_timezone: "America/New_York",
    });
    mocks.localDateKey.mockReturnValue("2026-09-15");
    mocks.localDateStorageValue.mockReturnValue(LOCAL_DATE);
  });

  it("persists an accepted provider response without starting the cold-call clock", async () => {
    const result = await persistLiveSmsProviderResult({
      messageId: message.id,
      attemptId: "a0000000-0000-4000-8000-00000000000a",
      outcome: "ACCEPTED",
      providerMessageId: "provider-message-1",
      providerStatus: "queued",
      providerResponse: { sid: "provider-message-1", accepted: true },
      actualSegmentCount: 2,
      actualCostMicros: 1600,
      occurredAt: NOW,
    });

    expect(result).toEqual({
      updated: true,
      reason: "recorded",
      messageStatus: "ACCEPTED",
    });
    expect(tx.smsOutboundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ACCEPTED",
          providerMessageId: "provider-message-1",
          responsePayload: { sid: "provider-message-1", accepted: true },
        }),
      }),
    );
    expect(tx.smsOutboundMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ACCEPTED",
          actualSegmentCount: 2,
          actualCostMicros: 1600,
        }),
      }),
    );
    expect(tx.smsUsageLedger.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ kind: "ACCEPTED" })],
      }),
    );
    expect(tx.outreachSequence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentState: "SMS_ACCEPTED",
          smsSentAt: null,
          coldCallDueAt: null,
          nextEligibleAt: null,
        }),
      }),
    );
  });

  it("marks an unknown submission terminal without releasing attempt capacity", async () => {
    await persistLiveSmsProviderResult({
      messageId: message.id,
      attemptId: "a0000000-0000-4000-8000-00000000000a",
      outcome: "UNKNOWN",
      providerStatus: "timeout",
      providerResponse: { timeout: true },
      occurredAt: NOW,
    });

    expect(tx.smsOutboundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "UNKNOWN" }),
      }),
    );
    expect(tx.outreachSequence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentState: "SMS_SUBMISSION_UNKNOWN",
          terminalAt: NOW,
          coldCallDueAt: null,
        }),
      }),
    );
    expect(tx.smsUsageLedger.createMany).not.toHaveBeenCalled();
    expect(tx.smsUsageLedger.create).not.toHaveBeenCalled();
  });

  it("lets genuine delivery recover SUBMISSION_UNKNOWN and records both ledgers", async () => {
    message.status = "SUBMISSION_UNKNOWN";
    message.providerMessageId = "provider-message-1";
    message.sequence.currentState = "SMS_SUBMISSION_UNKNOWN";
    message.sequence.terminalAt = NOW;
    tx.smsOutboundAttempt.findUnique.mockResolvedValue({
      id: "a0000000-0000-4000-8000-00000000000a",
      messageId: message.id,
      attemptNumber: 1,
      providerKey: "provider-x",
      providerMessageId: "provider-message-1",
      status: "UNKNOWN",
      finishedAt: NOW,
    } as never);

    const result = await persistSmsDeliveryStatus({
      messageId: message.id,
      providerKey: "provider-x",
      providerEventId: "delivery-event-1",
      providerMessageId: "provider-message-1",
      providerStatus: "delivered",
      outcome: "DELIVERED",
      rawPayload: { status: "delivered" },
      actualSegmentCount: 2,
      actualCostMicros: 1700,
      occurredAt: NOW,
      receivedAt: NOW,
    });

    expect(result.messageStatus).toBe("DELIVERED");
    expect(tx.smsOutboundMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DELIVERED" }),
      }),
    );
    expect(tx.smsOutboundAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "ACCEPTED",
          finishedAt: NOW,
        }),
      }),
    );
    expect(tx.outreachSequence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentState: "SMS_DELIVERED",
          terminalAt: null,
          terminalReason: null,
        }),
      }),
    );
    expect(tx.smsUsageLedger.createMany).toHaveBeenCalledTimes(2);
    expect(tx.smsUsageLedger.createMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: [expect.objectContaining({ kind: "ACCEPTED" })],
      }),
    );
    expect(tx.smsUsageLedger.createMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: [expect.objectContaining({ kind: "DELIVERED" })],
      }),
    );
  });

  it.each(["FAILED", "UNDELIVERED"])(
    "does not let delivery recover terminal %s",
    async (terminalStatus) => {
      message.status = terminalStatus;
      message.providerMessageId = "provider-message-1";

      const result = await persistSmsDeliveryStatus({
        messageId: message.id,
        providerKey: "provider-x",
        providerEventId: `late-${terminalStatus}`,
        providerMessageId: "provider-message-1",
        providerStatus: "delivered",
        outcome: "DELIVERED",
        rawPayload: { late: true },
        occurredAt: NOW,
        receivedAt: NOW,
      });

      expect(result).toMatchObject({
        updated: false,
        reason: "monotonic_noop",
        messageStatus: terminalStatus,
      });
      expect(tx.smsStatusEvent.create).toHaveBeenCalledTimes(1);
      expect(tx.smsOutboundMessage.update).not.toHaveBeenCalled();
      expect(tx.smsUsageLedger.createMany).not.toHaveBeenCalled();
    },
  );

  it("deduplicates provider delivery event IDs", async () => {
    tx.smsStatusEvent.findUnique.mockResolvedValue({
      messageId: message.id,
    });

    const result = await persistSmsDeliveryStatus({
      messageId: message.id,
      providerKey: "provider-x",
      providerEventId: "duplicate-event",
      providerMessageId: "provider-message-1",
      providerStatus: "sent",
      outcome: "SENT",
      rawPayload: {},
      occurredAt: NOW,
      receivedAt: NOW,
    });

    expect(result.reason).toBe("already_recorded");
    expect(tx.smsStatusEvent.create).not.toHaveBeenCalled();
    expect(tx.smsOutboundMessage.update).not.toHaveBeenCalled();
  });
});

describe("dry-run SMS result persistence", () => {
  it("audits the result without attempts, live usage, or a cold-call timer", async () => {
    const message = validMessage();
    const tx = makeTx(message);
    mocks.transaction.mockImplementation(
      async (callback: (client: typeof tx) => unknown) => callback(tx),
    );

    const result = await persistDryRunSmsResult({
      messageId: message.id,
      providerMessageId: "dry-message-1",
      providerResponse: { dryRun: true },
      requestFingerprint: "fingerprint",
      occurredAt: NOW,
    });

    expect(result.messageStatus).toBe("DRY_RUN");
    expect(tx.smsOutboundAttempt.create).not.toHaveBeenCalled();
    expect(tx.smsUsageLedger.create).not.toHaveBeenCalled();
    expect(tx.smsUsageLedger.createMany).not.toHaveBeenCalled();
    expect(tx.smsDailyUsage.upsert).not.toHaveBeenCalled();
    expect(tx.smsOutboundMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "DRY_RUN",
          actualCostMicros: 0,
        }),
      }),
    );
    const dryRunMessageData = tx.smsOutboundMessage.update.mock.calls[0]?.[0]
      ?.data as Record<string, unknown>;
    expect(dryRunMessageData).not.toHaveProperty("acceptedAt");
    expect(dryRunMessageData).not.toHaveProperty("sentAt");
    expect(tx.outreachSequence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentState: "SMS_DRY_RUN",
          smsSentAt: null,
          coldCallDueAt: null,
          nextEligibleAt: null,
        }),
      }),
    );
    expect(tx.smsAuditEvent.create).toHaveBeenCalledTimes(1);
  });
});
