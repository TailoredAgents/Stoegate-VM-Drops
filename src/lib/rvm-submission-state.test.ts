import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAppSettings: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/settings", () => ({ getAppSettings: mocks.getAppSettings }));

import {
  recordRvmDeliveryTx,
  recordRvmSubmissionUncertainTx,
} from "./outreach-service";

describe("RVM uncertain-submission state", () => {
  const campaignContactId = "20000000-0000-4000-8000-000000000002";
  let sequence: Record<string, unknown>;
  let events: Array<Record<string, unknown>>;
  let clearDropFailure: ReturnType<typeof vi.fn>;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    vi.clearAllMocks();
    sequence = {
      id: "60000000-0000-4000-8000-000000000006",
      campaignContactId,
      currentState: "RVM_SENT",
      terminalAt: null,
      terminalReason: null,
      rvmScheduledFor: new Date("2026-09-15T12:00:00.000Z"),
      version: 2,
    };
    events = [];
    clearDropFailure = vi.fn().mockResolvedValue({ count: 1 });
    const fakeTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: sequence.id }]),
      outreachSequence: {
        upsert: vi.fn(async () => ({ ...sequence })),
        findUniqueOrThrow: vi.fn(async () => ({ ...sequence })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          for (const [key, value] of Object.entries(data)) {
            if (key === "version") {
              sequence.version = Number(sequence.version) + 1;
            } else {
              sequence[key] = value;
            }
          }
          return { ...sequence };
        }),
      },
      outreachEvent: {
        findUnique: vi.fn(
          async ({ where }: { where: { idempotencyKey: string } }) =>
            events.find(
              (event) => event.idempotencyKey === where.idempotencyKey,
            ),
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const event = { id: `event-${events.length + 1}`, ...data };
          events.push(event);
          return event;
        }),
      },
      drop: { updateMany: clearDropFailure },
      campaignContact: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    tx = fakeTx as unknown as Prisma.TransactionClient;
    mocks.getAppSettings.mockResolvedValue({ rvm_to_sms_delay_hours: 24 });
  });

  it("audits a provider exception as terminal and lets a later delivery recover", async () => {
    const failedAt = new Date("2026-09-15T12:01:00.000Z");
    const uncertain = await recordRvmSubmissionUncertainTx(tx, {
      campaignContactId,
      occurredAt: failedAt,
      idempotencyKey: "drop:one:submission-unknown",
      errorMessage: "provider response was not received",
    });

    expect(uncertain.recorded).toBe(true);
    expect(sequence).toMatchObject({
      currentState: "RVM_FAILED",
      terminalAt: failedAt,
      terminalReason: "RVM_SUBMISSION_UNKNOWN",
      nextEligibleAt: null,
    });
    expect(events.at(-1)).toMatchObject({
      type: "RVM_FAILED",
      outcome: "RVM_SUBMISSION_UNKNOWN",
    });

    const deliveredAt = new Date("2026-09-15T12:03:00.000Z");
    await recordRvmDeliveryTx(tx, {
      campaignContactId,
      status: "DELIVERED",
      occurredAt: deliveredAt,
      idempotencyKey: "delivery:one:success",
    });

    expect(sequence).toMatchObject({
      currentState: "SMS_NOT_YET_ELIGIBLE",
      terminalAt: null,
      terminalReason: null,
      rvmSuccessfulAt: deliveredAt,
      smsEligibleAt: new Date("2026-09-16T12:03:00.000Z"),
    });
    expect(clearDropFailure).toHaveBeenCalledWith({
      where: {
        campaignContactId,
        status: "DELIVERED",
        errorCode: "RVM_SUBMISSION_UNKNOWN",
      },
      data: { failedAt: null, errorCode: null, errorMessage: null },
    });
  });

  it("does not recover a sequence stopped for a human callback", async () => {
    sequence.currentState = "RVM_CALLBACK";
    sequence.terminalAt = new Date("2026-09-15T12:02:00.000Z");
    sequence.terminalReason = "RVM_CALLBACK";

    await recordRvmDeliveryTx(tx, {
      campaignContactId,
      status: "DELIVERED",
      occurredAt: new Date("2026-09-15T12:03:00.000Z"),
      idempotencyKey: "delivery:callback:success",
    });

    expect(sequence.currentState).toBe("RVM_CALLBACK");
    expect(events).toHaveLength(0);
    expect(clearDropFailure).not.toHaveBeenCalled();
  });
});
