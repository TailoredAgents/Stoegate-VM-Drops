import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    getEnv: vi.fn(),
    constructor: vi.fn(),
    connect: vi.fn(async () => {
      events.push("connect");
    }),
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      events.push(`query:${sql}:${String(values?.[0])}`);
      return { rows: [] };
    }),
    end: vi.fn(async () => {
      events.push("end");
    }),
  };
});

vi.mock("pg", () => ({
  Client: class {
    constructor(config: unknown) {
      mocks.constructor(config);
    }

    connect = mocks.connect;
    query = mocks.query;
    end = mocks.end;
  },
}));
vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));

import {
  lockSmsCampaignDispatchTx,
  lockSmsPhoneDispatchTx,
  smsCampaignDispatchLockKey,
  smsPhoneDispatchLockKey,
  withSmsDispatchLock,
} from "./sms-dispatch-lock";

describe("SMS dispatch advisory locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.events.length = 0;
    mocks.getEnv.mockReturnValue({ DATABASE_URL: "postgresql://test/db" });
  });

  it("holds campaign and phone locks through the complete dispatch callback", async () => {
    await withSmsDispatchLock(
      { campaignId: "campaign-1", normalizedPhone: "+12025550123" },
      async () => {
        mocks.events.push("provider-and-persistence");
      },
    );

    expect(mocks.constructor).toHaveBeenCalledWith({
      connectionString: "postgresql://test/db",
    });
    expect(mocks.events).toEqual([
      "connect",
      `query:SELECT pg_advisory_lock_shared(hashtext($1))::text AS locked:${smsCampaignDispatchLockKey("campaign-1")}`,
      `query:SELECT pg_advisory_lock(hashtext($1))::text AS locked:${smsPhoneDispatchLockKey("+12025550123")}`,
      "provider-and-persistence",
      `query:SELECT pg_advisory_unlock(hashtext($1))::text AS unlocked:${smsPhoneDispatchLockKey("+12025550123")}`,
      `query:SELECT pg_advisory_unlock_shared(hashtext($1))::text AS unlocked:${smsCampaignDispatchLockKey("campaign-1")}`,
      "end",
    ]);
  });

  it("releases both locks when dispatch fails", async () => {
    await expect(
      withSmsDispatchLock(
        { campaignId: "campaign-1", normalizedPhone: "+12025550123" },
        async () => {
          throw new Error("provider failed");
        },
      ),
    ).rejects.toThrow("provider failed");

    expect(mocks.events.at(-3)).toContain("pg_advisory_unlock(hashtext");
    expect(mocks.events.at(-2)).toContain("pg_advisory_unlock_shared");
    expect(mocks.events.at(-1)).toBe("end");
  });

  it("uses the same keys for suppression and pause transactions", async () => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue([]) };

    await lockSmsPhoneDispatchTx(tx as never, "+12025550123");
    await lockSmsCampaignDispatchTx(tx as never, "campaign-1");

    expect(tx.$queryRaw.mock.calls[0]?.[1]).toBe(
      smsPhoneDispatchLockKey("+12025550123"),
    );
    expect(tx.$queryRaw.mock.calls[1]?.[1]).toBe(
      smsCampaignDispatchLockKey("campaign-1"),
    );
  });
});
