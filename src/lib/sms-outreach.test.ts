import { describe, expect, it } from "vitest";
import { COLD_CALL_CLOCK_STATES, coldCallDueAt } from "./sms-outreach";

describe("SMS to cold-call timing", () => {
  it("uses exact elapsed hours rather than calendar dates", () => {
    const sentAt = new Date("2026-03-07T17:00:00.000Z");
    expect(coldCallDueAt(sentAt, 48).toISOString()).toBe(
      "2026-03-09T17:00:00.000Z",
    );
  });

  it("does not treat provider acceptance as a confirmed send", () => {
    expect(COLD_CALL_CLOCK_STATES).toEqual(["SMS_SENT", "SMS_DELIVERED"]);
    expect(COLD_CALL_CLOCK_STATES).not.toContain("SMS_ACCEPTED");
  });
});
