import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  resolveBillingBoundaryPolicy,
  resolveImmutableBillingPeriodBounds,
} from "./billing-economics";

describe("immutable provider billing boundaries", () => {
  it("carries the established timezone and cycle day after settings change", () => {
    const anchor = {
      startsAt: new Date("2026-09-01T04:00:00.000Z"),
      timezone: "America/New_York",
      pricingSnapshot: {
        providerBillingCycleDay: 1,
      } as Prisma.JsonValue,
    };
    const fallback = { timezone: "America/Los_Angeles", cycleDay: 15 };
    expect(resolveBillingBoundaryPolicy(anchor, fallback)).toEqual({
      timezone: "America/New_York",
      cycleDay: 1,
    });
    const bounds = resolveImmutableBillingPeriodBounds(
      new Date("2026-10-20T16:00:00.000Z"),
      anchor,
      fallback,
    );
    expect(bounds).toMatchObject({
      start: new Date("2026-10-01T04:00:00.000Z"),
      end: new Date("2026-11-01T04:00:00.000Z"),
      policy: { timezone: "America/New_York", cycleDay: 1 },
    });
  });

  it("derives the cycle day from legacy period starts", () => {
    const policy = resolveBillingBoundaryPolicy(
      {
        startsAt: new Date("2026-09-10T04:00:00.000Z"),
        timezone: "America/New_York",
        pricingSnapshot: {} as Prisma.JsonValue,
      },
      { timezone: "UTC", cycleDay: 20 },
    );
    expect(policy).toEqual({ timezone: "America/New_York", cycleDay: 10 });
  });

  it("uses current settings only before the first period exists", () => {
    expect(
      resolveBillingBoundaryPolicy(null, {
        timezone: "America/Chicago",
        cycleDay: 8,
      }),
    ).toEqual({ timezone: "America/Chicago", cycleDay: 8 });
  });
});
