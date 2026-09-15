import { describe, expect, it } from "vitest";

import { initialOutboundFromPhone } from "./sms-provider-routing";

describe("SMS provider sender routing", () => {
  it("does not persist a Twilio Messaging Service SID as the actual sender", () => {
    expect(
      initialOutboundFromPhone(" Twilio ", `MG${"a".repeat(32)}`),
    ).toBeNull();
  });

  it("retains an explicitly assigned sender for providers that require one", () => {
    expect(initialOutboundFromPhone("mock", "+12025550123")).toBe(
      "+12025550123",
    );
  });
});
