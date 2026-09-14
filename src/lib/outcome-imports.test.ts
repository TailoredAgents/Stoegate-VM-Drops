import { describe, expect, it } from "vitest";
import {
  assertOutcomeIdentifiersMatch,
  coldCallOutcomeIdentifiers,
  coldCallOutcomeMatchMethod,
  getColdCallOutcomeConfirmation,
  getColdCallOutcomePreviewToken,
  getExternalOutcomePreviewToken,
  parseColdCallOutcomeCsv,
  parseColdCallOutcomeOccurrence,
  selectUniqueBatchDialerMatch,
  stableColdCallOutcomeIdempotencyKey,
} from "./outcome-imports";

const target = {
  exportItemId: "0e1b60b3-53ad-4bed-8eb4-a4a07fe130ed",
  exportId: "56933d7d-0447-4b48-9970-5a0bdcc4ced5",
  campaignContactId: "c5102d1c-2714-4ff9-99a8-e20f06c180a6",
  contactId: "22a320ca-b85a-4a6b-af29-8ecc9a2030ac",
  normalizedPhone: "+12025550142",
};

describe("cold-call outcome import safeguards", () => {
  it("requires every supplied identifier to identify the same export row", () => {
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
          exportId: "021f60d9-12b1-4e84-8082-e07a3c273afb",
        },
        target,
      ),
    ).toThrow("Export ID does not match");
  });

  it("recognizes the stable IDs emitted by a BatchDialer export", () => {
    expect(
      coldCallOutcomeIdentifiers({
        stonegate_export_id: target.exportId,
        stonegate_campaign_contact_id: target.campaignContactId,
        stonegate_contact_id: target.contactId,
        phone: "(202) 555-0142",
      }),
    ).toEqual({
      exportItemId: undefined,
      exportId: target.exportId,
      campaignContactId: target.campaignContactId,
      contactId: target.contactId,
      normalizedPhone: target.normalizedPhone,
    });
    expect(
      coldCallOutcomeMatchMethod({
        exportId: target.exportId,
        contactId: target.contactId,
      }),
    ).toBe("EXPORT_AND_CONTACT");
  });

  it("normalizes common provider CSV headers", () => {
    expect(
      parseColdCallOutcomeCsv(
        Buffer.from(
          "Stonegate Export ID,Stonegate Contact ID,Call Outcome\n" +
            `${target.exportId},${target.contactId},No Answer\n`,
        ),
      ),
    ).toEqual([
      {
        stonegate_export_id: target.exportId,
        stonegate_contact_id: target.contactId,
        call_outcome: "No Answer",
      },
    ]);
  });

  it("allows repeated exports of one sequence but rejects ambiguous contacts", () => {
    expect(
      selectUniqueBatchDialerMatch([
        { sequenceId: "sequence-a", exportId: "new" },
        { sequenceId: "sequence-a", exportId: "old" },
      ]),
    ).toEqual({ sequenceId: "sequence-a", exportId: "new" });
    expect(() =>
      selectUniqueBatchDialerMatch([
        { sequenceId: "sequence-a" },
        { sequenceId: "sequence-b" },
      ]),
    ).toThrow("ambiguous");
  });

  it("requires timezone-qualified supplied timestamps and allows omission", () => {
    const fallback = new Date("2026-09-14T12:00:00Z");
    expect(parseColdCallOutcomeOccurrence({}, fallback)).toEqual({
      value: fallback,
      raw: null,
    });
    expect(() =>
      parseColdCallOutcomeOccurrence(
        { call_timestamp: "2026-09-14T17:15:00" },
        fallback,
      ),
    ).toThrow("with a timezone");
    expect(
      parseColdCallOutcomeOccurrence(
        { disposition_at: "2026-09-14T17:15:00-04:00" },
        fallback,
      ).value.toISOString(),
    ).toBe("2026-09-14T21:15:00.000Z");
  });

  it("creates a stable semantic fingerprint scoped to the export", () => {
    const value = {
      sequenceId: "d8cb8f0f-4438-45eb-a49c-c942f9d66789",
      exportId: target.exportId,
      outcome: "QUALIFIED_LEAD" as const,
      occurredAtIso: "2026-09-14T17:15:00.000Z",
    };
    expect(stableColdCallOutcomeIdempotencyKey(value)).toBe(
      stableColdCallOutcomeIdempotencyKey({ ...value }),
    );
    expect(stableColdCallOutcomeIdempotencyKey(value)).not.toBe(
      stableColdCallOutcomeIdempotencyKey({
        ...value,
        exportId: "021f60d9-12b1-4e84-8082-e07a3c273afb",
      }),
    );
  });

  it("binds the preview token to the exact file and cold-call workflow", () => {
    const bytes = Buffer.from("Phone,Disposition\n2025550142,Contacted\n");
    expect(getColdCallOutcomePreviewToken(bytes)).toBe(
      getColdCallOutcomePreviewToken(Buffer.from(bytes)),
    );
    expect(getColdCallOutcomePreviewToken(bytes)).not.toBe(
      getColdCallOutcomePreviewToken(Buffer.from(`${bytes.toString()} `)),
    );
    expect(getExternalOutcomePreviewToken("COLD_CALL", bytes)).toBe(
      getColdCallOutcomePreviewToken(bytes),
    );
    expect(() => getExternalOutcomePreviewToken("SMS", bytes)).toThrow(
      "Only COLD_CALL",
    );
  });

  it("uses a typed confirmation that exposes partial acceptance", () => {
    expect(getColdCallOutcomeConfirmation(7, 10)).toBe(
      "IMPORT COLD CALL 7 OF 10",
    );
  });
});
