import { describe, expect, it } from "vitest";
import {
  assertColdCallOutcomeAllowed,
  assertExternalOutcomeAllowed,
  COLD_CALL_OUTCOMES,
  normalizeColdCallOutcome,
} from "./external-outcome-policy";

const exportedAt = new Date("2026-09-15T12:00:00.000Z");
const base = {
  currentState: "COLD_CALL_EXPORTED" as const,
  coldCallExportedAt: exportedAt,
};

describe("cold-call outcome policy", () => {
  it.each(COLD_CALL_OUTCOMES)(
    "accepts %s only after a BatchDialer export",
    (outcome) => {
      expect(
        assertColdCallOutcomeAllowed(
          base,
          outcome,
          new Date("2026-09-15T13:00:00.000Z"),
        ),
      ).toMatchObject({ terminal: true });
    },
  );

  it("normalizes provider-neutral aliases to the canonical vocabulary", () => {
    expect(normalizeColdCallOutcome("Qualified Lead")).toBe("QUALIFIED_LEAD");
    expect(normalizeColdCallOutcome("Do Not Call")).toBe("DNC");
    expect(normalizeColdCallOutcome("No-Response")).toBe("NO_ANSWER");
  });

  it("requires a BatchDialer export even for a suppression", () => {
    expect(() =>
      assertColdCallOutcomeAllowed(
        { ...base, coldCallExportedAt: null },
        "DNC",
        new Date("2026-09-15T13:00:00.000Z"),
      ),
    ).toThrow("not exported to BatchDialer");
  });

  it("rejects dispositions dated before the BatchDialer handoff", () => {
    expect(() =>
      assertColdCallOutcomeAllowed(
        base,
        "CONTACTED",
        new Date("2026-09-15T11:59:59.999Z"),
      ),
    ).toThrow("before the BatchDialer export");
  });

  it("does not let a non-suppression overwrite a suppressed sequence", () => {
    expect(() =>
      assertColdCallOutcomeAllowed(
        { ...base, currentState: "OPT_OUT" },
        "INTERESTED",
        new Date("2026-09-15T13:00:00.000Z"),
      ),
    ).toThrow("suppressed at OPT_OUT");
    expect(() =>
      assertColdCallOutcomeAllowed(
        { ...base, currentState: "OPT_OUT" },
        "DNC",
        new Date("2026-09-15T13:00:00.000Z"),
      ),
    ).not.toThrow();
  });

  it("rejects SMS imports and SMS-only results", () => {
    expect(() =>
      assertExternalOutcomeAllowed(
        base,
        "SMS",
        "reply",
        new Date("2026-09-15T13:00:00.000Z"),
      ),
    ).toThrow("Only COLD_CALL");
    expect(() => normalizeColdCallOutcome("sent")).toThrow(
      "Unsupported cold-call outcome",
    );
  });
});
