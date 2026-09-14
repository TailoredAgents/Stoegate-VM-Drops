import { describe, expect, it } from "vitest";

import { suppressionSequenceState } from "@/lib/suppression";

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
});
