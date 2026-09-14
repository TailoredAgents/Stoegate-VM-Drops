import { describe, expect, it } from "vitest";
import {
  getBusinessSendWindowAvailability,
  getBillingPeriodBounds,
  getLocalDayBounds,
  getSendWindowAvailability,
  localDateKey,
} from "./time";

describe("timezone-aware operating boundaries", () => {
  it("uses the configured local day across UTC midnight", () => {
    expect(
      localDateKey(new Date("2026-09-15T02:00:00.000Z"), "America/New_York"),
    ).toBe("2026-09-14");
  });

  it("handles DST days as local calendar days, not fixed 24-hour UTC buckets", () => {
    const spring = getLocalDayBounds(
      new Date("2026-03-08T16:00:00.000Z"),
      "America/New_York",
    );
    const fall = getLocalDayBounds(
      new Date("2026-11-01T16:00:00.000Z"),
      "America/New_York",
    );
    expect(spring.end.getTime() - spring.start.getTime()).toBe(
      23 * 60 * 60 * 1000,
    );
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("builds monthly billing boundaries and the next safe send-window time", () => {
    const period = getBillingPeriodBounds(
      new Date("2026-09-14T16:00:00.000Z"),
      "America/New_York",
      1,
    );
    expect(period.start.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(
      getSendWindowAvailability(
        new Date("2026-09-14T11:00:00.000Z"),
        "America/New_York",
        "08:00",
        "21:00",
      ),
    ).toMatchObject({
      allowed: false,
      nextAllowedAt: new Date("2026-09-14T12:00:00.000Z"),
    });
  });
});

describe("business-day SMS windows", () => {
  it("moves a Saturday send to Monday morning in the campaign timezone", () => {
    const availability = getBusinessSendWindowAvailability(
      new Date("2026-09-19T16:00:00.000Z"),
      "America/New_York",
      "09:00",
      "17:00",
    );

    expect(availability).toEqual({
      allowed: false,
      nextAllowedAt: new Date("2026-09-21T13:00:00.000Z"),
    });
  });

  it("allows a weekday instant inside the local send window", () => {
    expect(
      getBusinessSendWindowAvailability(
        new Date("2026-09-21T14:00:00.000Z"),
        "America/New_York",
        "09:00",
        "17:00",
      ),
    ).toEqual({ allowed: true });
  });
});
