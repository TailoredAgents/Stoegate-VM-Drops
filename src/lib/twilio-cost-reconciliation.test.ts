import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  createAudit: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/db", () => ({
  db: {
    smsOutboundMessage: {
      findMany: mocks.findMany,
      updateMany: mocks.updateMany,
    },
    smsAuditEvent: { create: mocks.createAudit },
    $transaction: mocks.transaction,
  },
}));

import {
  reconcileTwilioMessageCosts,
  twilioPriceToMicros,
  type TwilioCostClient,
} from "./twilio-cost-reconciliation";

describe("Twilio actual-cost reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnv.mockReturnValue({
      TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
      TWILIO_AUTH_TOKEN: "test-token",
    });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.createAudit.mockResolvedValue({ id: "audit-1" });
    mocks.transaction.mockImplementation(async (work) =>
      work({
        smsOutboundMessage: { updateMany: mocks.updateMany },
        smsAuditEvent: { create: mocks.createAudit },
      }),
    );
  });

  it("converts Twilio's signed decimal charge into positive USD micros", () => {
    expect(twilioPriceToMicros("-0.0079")).toBe(7_900);
    expect(twilioPriceToMicros("0")).toBe(0);
    expect(twilioPriceToMicros(null)).toBeNull();
    expect(twilioPriceToMicros("not-a-price")).toBeNull();
  });

  it("retrieves only existing messages and stores actual cost separately", async () => {
    const sid = `SM${"b".repeat(32)}`;
    mocks.findMany.mockResolvedValue([
      { id: "message-1", providerMessageId: sid, fromPhone: null },
    ]);
    const fetch = vi.fn().mockResolvedValue({
      sid,
      price: "-0.0083",
      priceUnit: "usd",
      numSegments: "2",
      from: "+12025550999",
    });
    const client = {
      messages: vi.fn(() => ({ fetch })),
    } as TwilioCostClient;

    await expect(
      reconcileTwilioMessageCosts({
        actorUserId: "admin-1",
        client,
      }),
    ).resolves.toEqual({
      examined: 1,
      reconciled: 1,
      pendingPrice: 0,
      failed: 0,
    });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "message-1", actualCostMicros: null },
      data: {
        actualCostMicros: 8_300,
        currency: "USD",
        actualSegmentCount: 2,
        fromPhone: "+12025550999",
      },
    });
    expect(mocks.createAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "TWILIO_COST_RECONCILED",
          actorUserId: "admin-1",
        }),
      }),
    );
  });

  it("does not write while either Twilio price or its currency is pending", async () => {
    const sid = `SM${"c".repeat(32)}`;
    mocks.findMany.mockResolvedValue([
      { id: "message-2", providerMessageId: sid, fromPhone: null },
    ]);
    const client = {
      messages: vi.fn(() => ({
        fetch: vi
          .fn()
          .mockResolvedValue({ sid, price: "-0.0083", priceUnit: null }),
      })),
    } as TwilioCostClient;

    const result = await reconcileTwilioMessageCosts({
      actorUserId: "admin-1",
      client,
    });

    expect(result.pendingPrice).toBe(1);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.createAudit).not.toHaveBeenCalled();
  });
});
