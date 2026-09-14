import { describe, expect, it } from "vitest";
import { createCsv, protectSpreadsheetCell } from "./csv";

describe("outreach CSV safety", () => {
  it("quotes RFC 4180 fields and protects spreadsheet formulas", () => {
    expect(protectSpreadsheetCell('=HYPERLINK("bad")')).toBe(
      '\'=HYPERLINK("bad")',
    );
    const csv = createCsv(
      ["Name", "Phone"],
      [{ Name: "Smith, Jane", Phone: "+12025550101" }],
      new Set(["Phone"]),
    );
    expect(csv).toContain('"Smith, Jane","+12025550101"\r\n');
  });
});
