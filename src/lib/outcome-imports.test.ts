import { describe, expect, it } from "vitest";
import {
  assertOutcomeIdentifiersMatch,
  getExternalOutcomePreviewToken,
  normalizeExternalOutcomeResult,
  parseExternalOutcomeOccurrence,
  stableOutcomeIdempotencyKey,
} from "./outcome-imports";

const target = {
  campaignContactId: "c5102d1c-2714-4ff9-99a8-e20f06c180a6",
  contactId: "22a320ca-b85a-4a6b-af29-8ecc9a2030ac",
  normalizedPhone: "+12025550142",
};

describe("external outcome import safeguards", () => {
  it("requires every supplied identifier to identify the same target", () => {
    expect(() => assertOutcomeIdentifiersMatch(target, target)).not.toThrow();
    expect(() =>
      assertOutcomeIdentifiersMatch(
        { ...target, normalizedPhone: "+12025550999" },
        target,
      ),
    ).toThrow("Phone does not match");
    expect(() =>
      assertOutcomeIdentifiersMatch(
        {
          ...target,
          campaignContactId: "70bf20d6-2441-4368-8a74-0cb3927eed95",
        },
        target,
      ),
    ).toThrow("Campaign Contact ID does not match");
  });

  it("creates a stable semantic fingerprint without an external ID", () => {
    const value = {
      channel: "SMS" as const,
      sequenceId: "d8cb8f0f-4438-45eb-a49c-c942f9d66789",
      normalizedResult: normalizeExternalOutcomeResult("Qualified Lead"),
      occurredAtRaw: "2026-09-14T17:15:00Z",
    };
    expect(stableOutcomeIdempotencyKey(value)).toBe(
      stableOutcomeIdempotencyKey({ ...value }),
    );
    expect(stableOutcomeIdempotencyKey(value)).not.toBe(
      stableOutcomeIdempotencyKey({ ...value, normalizedResult: "opt_out" }),
    );
  });

  it("requires a timezone-qualified timestamp for an SMS sent row", () => {
    const fallback = new Date("2026-09-14T12:00:00Z");
    expect(() =>
      parseExternalOutcomeOccurrence({}, "SMS", "sent", fallback),
    ).toThrow("Sent At or Occurred At is required");
    expect(() =>
      parseExternalOutcomeOccurrence(
        { sent_at: "2026-09-14T17:15:00" },
        "SMS",
        "sent",
        fallback,
      ),
    ).toThrow("with a timezone");
    expect(
      parseExternalOutcomeOccurrence(
        { sent_at: "2026-09-14T17:15:00-04:00" },
        "SMS",
        "sent",
        fallback,
      ).value.toISOString(),
    ).toBe("2026-09-14T21:15:00.000Z");
  });

  it("binds a preview token to both the channel and exact file bytes", () => {
    const bytes = Buffer.from("Phone,Result\n2025550142,reply\n");
    expect(getExternalOutcomePreviewToken("SMS", bytes)).toBe(
      getExternalOutcomePreviewToken("SMS", Buffer.from(bytes)),
    );
    expect(getExternalOutcomePreviewToken("SMS", bytes)).not.toBe(
      getExternalOutcomePreviewToken("COLD_CALL", bytes),
    );
  });
});
