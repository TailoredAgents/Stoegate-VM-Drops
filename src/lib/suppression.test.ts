import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lockSmsPhoneDispatchTx: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/sms-dispatch-lock", () => ({
  lockSmsPhoneDispatchTx: mocks.lockSmsPhoneDispatchTx,
}));

import {
  suppressPhoneGlobally,
  suppressPhoneGloballyWhileDispatchLocked,
  suppressionSequenceState,
} from "@/lib/suppression";

function makeTx() {
  return {
    contact: { findUnique: vi.fn().mockResolvedValue(null) },
    suppressionEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "suppression-1" }),
    },
    campaignContact: { findMany: vi.fn().mockResolvedValue([]) },
    smsOutboundMessage: { updateMany: vi.fn() },
    smsConversation: { updateMany: vi.fn() },
    smsAuditEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("global SMS suppression state", () => {
  it("moves an active sequence to opt-out or wrong-number", () => {
    expect(suppressionSequenceState("SMS_QUEUED", "OPT_OUT")).toBe("OPT_OUT");
    expect(suppressionSequenceState("SMS_SENT", "WRONG_NUMBER")).toBe(
      "WRONG_NUMBER",
    );
  });

  it("does not erase a previously qualified outcome", () => {
    expect(suppressionSequenceState("QUALIFIED_LEAD", "MANUAL")).toBe(
      "QUALIFIED_LEAD",
    );
    expect(suppressionSequenceState("CLOSED", "OPT_OUT")).toBe("CLOSED");
  });

  it("does not reacquire a phone lock already held across provider dispatch", async () => {
    const tx = makeTx();
    mocks.transaction.mockImplementation(async (work) => work(tx));
    const input = {
      normalizedPhone: "+12025550123",
      reason: "PROVIDER_DNC" as const,
      source: "twilio_provider_opt_out",
      idempotencyKey: "twilio-provider-opt-out:event-1",
    };

    await suppressPhoneGloballyWhileDispatchLocked(input);
    expect(mocks.lockSmsPhoneDispatchTx).not.toHaveBeenCalled();
    expect(tx.suppressionEntry.upsert).toHaveBeenCalled();
    expect(tx.smsAuditEvent.create).toHaveBeenCalled();

    await suppressPhoneGlobally({
      ...input,
      idempotencyKey: "twilio-provider-opt-out:event-2",
    });
    expect(mocks.lockSmsPhoneDispatchTx).toHaveBeenCalledWith(
      tx,
      input.normalizedPhone,
    );
  });
});
