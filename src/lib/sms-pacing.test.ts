import { describe, expect, it } from "vitest";

import { requireSmsSendIntervalSeconds, scheduledSmsTime } from "./sms-pacing";

describe("SMS campaign pacing", () => {
  it("assigns a stable scheduled time from the contact position", () => {
    const start = new Date("2026-09-15T13:00:00.000Z");

    expect(scheduledSmsTime(start, 0, 7)).toEqual(start);
    expect(scheduledSmsTime(start, 3, 7)).toEqual(
      new Date("2026-09-15T13:00:21.000Z"),
    );
  });

  it("rejects unsafe interval values", () => {
    expect(() => requireSmsSendIntervalSeconds(0)).toThrow(
      /between 1 and 3600/,
    );
    expect(() => requireSmsSendIntervalSeconds(3601)).toThrow(
      /between 1 and 3600/,
    );
    expect(() => requireSmsSendIntervalSeconds(1.5)).toThrow(
      /between 1 and 3600/,
    );
  });
});
