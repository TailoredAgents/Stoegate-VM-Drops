import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findCandidateIds: vi.fn(),
  findEvents: vi.fn(),
  attachEvent: vi.fn(),
  updateEvent: vi.fn(),
  findOutbound: vi.fn(),
  persistStatus: vi.fn(),
  suppressPhoneGlobally: vi.fn(),
  suppressPhoneGloballyWhileDispatchLocked: vi.fn(),
  withSmsPhoneDispatchLock: vi.fn(
    async (_normalizedPhone: string, operation: () => Promise<unknown>) =>
      operation(),
  ),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: mocks.findCandidateIds,
    smsStatusEvent: {
      findMany: mocks.findEvents,
      updateMany: mocks.attachEvent,
      update: mocks.updateEvent,
    },
    smsOutboundMessage: { findFirst: mocks.findOutbound },
  },
}));
vi.mock("@/lib/sms-operations", () => ({
  persistSmsDeliveryStatus: mocks.persistStatus,
}));
vi.mock("@/lib/sms-conversations", () => ({
  recordSmsInboundMessage: vi.fn(),
}));
vi.mock("@/lib/suppression", () => ({
  suppressPhoneGlobally: mocks.suppressPhoneGlobally,
  suppressPhoneGloballyWhileDispatchLocked:
    mocks.suppressPhoneGloballyWhileDispatchLocked,
}));
vi.mock("@/lib/sms-dispatch-lock", () => ({
  withSmsPhoneDispatchLock: mocks.withSmsPhoneDispatchLock,
}));

import { reconcileUnmatchedSmsStatusEvents } from "./sms-webhooks";

const retainedUnknownTwilioStatus = {
  id: "status-event-id",
  messageId: null,
  providerKey: "twilio",
  providerEventId: "twilio-status:event-hash",
  providerMessageId: `SM${"a".repeat(32)}`,
  status: null,
  providerStatus: "future-status",
  errorCode: null,
  errorMessage: null,
  rawPayload: {
    MessageSid: `SM${"a".repeat(32)}`,
    MessageStatus: "future-status",
  },
  occurredAt: null,
  receivedAt: new Date("2030-01-02T03:04:05.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findCandidateIds.mockResolvedValue([{ id: "status-event-id" }]);
  mocks.findEvents.mockResolvedValue([retainedUnknownTwilioStatus]);
  mocks.findOutbound.mockResolvedValue({
    id: "outbound-message-id",
    toPhone: "+12025550123",
  });
  mocks.attachEvent.mockResolvedValue({ count: 1 });
});

describe("unmatched SMS status reconciliation", () => {
  it("attaches a retained canonical-null Twilio event without projecting state", async () => {
    const result = await reconcileUnmatchedSmsStatusEvents(25);

    expect(mocks.findEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["status-event-id"] },
          providerMessageId: { not: null },
          OR: expect.arrayContaining([
            expect.objectContaining({ messageId: null }),
            expect.objectContaining({
              messageId: { not: null },
              providerKey: "twilio",
              errorCode: "21610",
              processedAt: null,
            }),
          ]),
        }),
      }),
    );
    const [sql, boundedLimit] = mocks.findCandidateIds.mock.calls[0];
    expect(Array.from(sql).join("?")).toContain("AND EXISTS");
    expect(boundedLimit).toBe(25);
    expect(mocks.findOutbound).toHaveBeenCalledWith({
      where: {
        providerKey: "twilio",
        providerMessageId: retainedUnknownTwilioStatus.providerMessageId,
      },
      select: { id: true, toPhone: true },
    });
    expect(mocks.attachEvent).toHaveBeenCalledWith({
      where: { id: "status-event-id", messageId: null, status: null },
      data: {
        messageId: "outbound-message-id",
        processedAt: expect.any(Date),
        processingError: null,
      },
    });
    expect(mocks.attachEvent.mock.calls[0][0].data).not.toHaveProperty(
      "status",
    );
    expect(mocks.persistStatus).not.toHaveBeenCalled();
    expect(result).toEqual({ examined: 1, matched: 1 });
  });

  it("leaves the retained event unmatched until the provider result exists", async () => {
    mocks.findOutbound.mockResolvedValue(null);

    await expect(reconcileUnmatchedSmsStatusEvents()).resolves.toEqual({
      examined: 1,
      matched: 0,
    });
    expect(mocks.attachEvent).not.toHaveBeenCalled();
    expect(mocks.persistStatus).not.toHaveBeenCalled();
  });

  it("does not spend the batch limit on permanent unmatched orphans", async () => {
    mocks.findCandidateIds.mockResolvedValue([]);

    await expect(reconcileUnmatchedSmsStatusEvents(100)).resolves.toEqual({
      examined: 0,
      matched: 0,
    });
    expect(mocks.findEvents).not.toHaveBeenCalled();
  });

  it("does not apply an opt-out when a retained callback recipient conflicts", async () => {
    mocks.findEvents.mockResolvedValue([
      {
        ...retainedUnknownTwilioStatus,
        errorCode: "21610",
        rawPayload: {
          ...retainedUnknownTwilioStatus.rawPayload,
          To: "+12025550124",
        },
      },
    ]);

    await reconcileUnmatchedSmsStatusEvents();

    expect(mocks.attachEvent).toHaveBeenCalledTimes(2);
    expect(mocks.suppressPhoneGlobally).not.toHaveBeenCalled();
    expect(
      mocks.suppressPhoneGloballyWhileDispatchLocked,
    ).not.toHaveBeenCalled();
    expect(mocks.attachEvent).toHaveBeenLastCalledWith({
      where: {
        providerKey: "twilio",
        providerEventId: retainedUnknownTwilioStatus.providerEventId,
        messageId: "outbound-message-id",
      },
      data: { processedAt: expect.any(Date), processingError: null },
    });
  });

  it("retries an attached provider opt-out until suppression succeeds", async () => {
    const providerOptOut = {
      ...retainedUnknownTwilioStatus,
      errorCode: "21610",
      rawPayload: {
        ...retainedUnknownTwilioStatus.rawPayload,
        To: "+12025550123",
      },
    };
    mocks.findEvents
      .mockResolvedValueOnce([providerOptOut])
      .mockResolvedValueOnce([
        {
          ...providerOptOut,
          messageId: "outbound-message-id",
          processedAt: null,
          processingError: "temporary suppression failure",
        },
      ]);
    mocks.suppressPhoneGloballyWhileDispatchLocked
      .mockRejectedValueOnce(new Error("temporary suppression failure"))
      .mockResolvedValueOnce({ duplicate: false });

    await expect(reconcileUnmatchedSmsStatusEvents()).resolves.toEqual({
      examined: 1,
      matched: 0,
    });
    expect(mocks.updateEvent).toHaveBeenCalledWith({
      where: { id: "status-event-id" },
      data: {
        processingError: "temporary suppression failure",
      },
    });

    await expect(reconcileUnmatchedSmsStatusEvents()).resolves.toEqual({
      examined: 1,
      matched: 1,
    });
    expect(mocks.withSmsPhoneDispatchLock).toHaveBeenCalledTimes(2);
    expect(
      mocks.suppressPhoneGloballyWhileDispatchLocked,
    ).toHaveBeenCalledTimes(2);
    expect(mocks.attachEvent).toHaveBeenLastCalledWith({
      where: {
        providerKey: "twilio",
        providerEventId: providerOptOut.providerEventId,
        messageId: "outbound-message-id",
      },
      data: { processedAt: expect.any(Date), processingError: null },
    });
  });
});
