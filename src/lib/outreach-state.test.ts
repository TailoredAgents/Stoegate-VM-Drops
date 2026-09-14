import { describe, expect, it } from "vitest";
import {
  eligibilityAt,
  externalOutcomeTransition,
  isRvmToSmsDue,
  isSmsToColdCallDue,
  shouldStopForCallbackOutcome,
} from "./outreach-state";

describe("outreach sequence rules", () => {
  const anchor = new Date("2026-09-14T14:00:00.000Z");

  it("makes RVM success SMS-eligible at exactly 24 elapsed hours", () => {
    const due = eligibilityAt(anchor, 24);
    expect(due.toISOString()).toBe("2026-09-15T14:00:00.000Z");
    expect(
      isRvmToSmsDue(
        "SMS_NOT_YET_ELIGIBLE",
        due,
        new Date("2026-09-15T13:59:59.999Z"),
      ),
    ).toBe(false);
    expect(isRvmToSmsDue("SMS_NOT_YET_ELIGIBLE", due, due)).toBe(true);
  });

  it("makes only a confirmed external SMS send eligible after 48 hours", () => {
    const due = eligibilityAt(anchor, 48);
    expect(isSmsToColdCallDue("SMS_SENT_EXTERNAL", due, due)).toBe(true);
    expect(
      isSmsToColdCallDue("SMS_SENT_EXTERNAL", due, new Date(due.getTime() - 1)),
    ).toBe(false);
    expect(isSmsToColdCallDue("SMS_FAILED", due, due)).toBe(false);
  });

  it("treats every human callback result as a deliberate sequence stop", () => {
    for (const outcome of [
      "CALLBACK",
      "INTERESTED",
      "QUALIFIED_LEAD",
      "FOLLOW_UP",
      "NOT_INTERESTED",
      "WRONG_NUMBER",
      "OPT_OUT",
      "CONTRACT",
      "CLOSED",
    ] as const)
      expect(shouldStopForCallbackOutcome(outcome)).toBe(true);
  });

  it("maps SMS replies and suppression outcomes without enabling a provider", () => {
    expect(externalOutcomeTransition("SMS", "reply")).toMatchObject({
      state: "SMS_REPLIED",
      terminal: true,
    });
    expect(externalOutcomeTransition("SMS", "opt out")).toMatchObject({
      state: "OPT_OUT",
      terminal: true,
      suppress: "OPT_OUT",
    });
    expect(externalOutcomeTransition("SMS", "qualified lead")).toMatchObject({
      state: "QUALIFIED_LEAD",
      terminal: true,
      lead: true,
    });
  });
});
