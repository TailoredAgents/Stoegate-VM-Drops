import { describe, expect, it } from "vitest";

import { isProviderOptOutSignal } from "./provider-suppression";

describe("provider suppression signals", () => {
  it("recognizes only Twilio's documented recipient opt-out error", () => {
    expect(isProviderOptOutSignal("twilio", "21610")).toBe(true);
    expect(isProviderOptOutSignal("TWILIO", " 21610 ")).toBe(true);
    expect(isProviderOptOutSignal("twilio", "30007")).toBe(false);
    expect(isProviderOptOutSignal("other", "21610")).toBe(false);
  });
});
