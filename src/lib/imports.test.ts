import { describe, expect, it } from "vitest";
import { analyzeImportRows, summarizeImport } from "./imports";

describe("import analysis", () => {
  const mapping = { phone: "Phone", property_address: "Address" };

  it("deduplicates exact phone/property pairs but keeps distinct properties for one phone", () => {
    const rows = analyzeImportRows(
      [
        { Phone: "770-555-1234", Address: "1 Main St" },
        { Phone: "770-555-1234", Address: "1 Main St" },
        { Phone: "770-555-1234", Address: "2 Main St" },
      ],
      mapping,
      new Set(),
    );
    expect(rows.map((row) => row.status)).toEqual([
      "ELIGIBLE",
      "DUPLICATE_PHONE_PROPERTY",
      "ELIGIBLE",
    ]);
  });

  it("applies suppression and classifies bad input before commit", () => {
    const rows = analyzeImportRows(
      [
        { Phone: "7705551234", Address: "1 Main" },
        { Phone: "bad", Address: "2 Main" },
        { Phone: "", Address: "3 Main" },
      ],
      mapping,
      new Set(["+17705551234"]),
    );
    expect(summarizeImport(rows)).toMatchObject({
      uploaded: 3,
      eligible: 0,
      suppressed: 1,
      invalid: 1,
      missing: 1,
    });
  });
});
