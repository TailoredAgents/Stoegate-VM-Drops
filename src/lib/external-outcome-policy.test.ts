import { describe, expect, it } from "vitest";
import { assertExternalOutcomeAllowed } from "./external-outcome-policy";

const sentAt = new Date("2026-09-15T12:00:00.000Z");
const base = {
  currentState: "SMS_SENT_EXTERNAL" as const,
  rvmSuccessfulAt: new Date("2026-09-14T10:00:00.000Z"),
  smsEligibleAt: new Date("2026-09-15T10:00:00.000Z"),
  smsExportedAt: new Date("2026-09-15T11:00:00.000Z"),
  smsSentAt: sentAt,
  coldCallExportedAt: null,
};

describe("external outcome stage policy", () => {
  it("requires a recorded SMS send before attributing a reply", () => {
    expect(() =>
      assertExternalOutcomeAllowed(
        { ...base, currentState: "SMS_EXPORTED", smsSentAt: null },
        "SMS",
        "reply",
        new Date("2026-09-15T13:00:00.000Z"),
      ),
    ).toThrow("recorded external send");
  });

  it("rejects a repeated sent command so it cannot reset the timer", () => {
    expect(() =>
      assertExternalOutcomeAllowed(base, "SMS", "sent", sentAt),
    ).toThrow("already recorded");
  });

  it("requires a BatchDialer export before a cold-call outcome", () => {
    expect(() =>
      assertExternalOutcomeAllowed(
        base,
        "COLD_CALL",
        "qualified lead",
        new Date("2026-09-18T12:00:00.000Z"),
      ),
    ).toThrow("not exported");
  });

  it("always accepts a suppression classification after identity validation", () => {
    expect(
      assertExternalOutcomeAllowed(
        {
          currentState: "RVM_PENDING",
          rvmSuccessfulAt: null,
          smsEligibleAt: null,
          smsExportedAt: null,
          smsSentAt: null,
          coldCallExportedAt: null,
        },
        "SMS",
        "opt out",
        sentAt,
      ),
    ).toMatchObject({ state: "OPT_OUT", suppress: "OPT_OUT" });
  });
});
