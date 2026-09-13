import { describe, expect, it } from "vitest";
import { normalizeUSPhone } from "./phone";

describe("normalizeUSPhone", () => {
  it("normalizes common US formats to E.164", () => {
    expect(normalizeUSPhone("(770) 555-1234")).toBe("+17705551234");
    expect(normalizeUSPhone("1-770-555-1234")).toBe("+17705551234");
  });

  it("rejects invalid and non-US numbers", () => {
    expect(normalizeUSPhone("555")).toBeNull();
    expect(normalizeUSPhone("+442079460018")).toBeNull();
  });
});
