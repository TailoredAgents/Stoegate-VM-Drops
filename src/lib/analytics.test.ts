import { describe, expect, it } from "vitest";
import {
  areSmsCostCurrenciesComparable,
  analyticsDateRange,
  buildAnalyticsCampaignContactWhere,
  buildSentMessageLifecycleWhere,
  buildSmsCampaignInboundWhere,
  effectiveGlobalDailySmsCap,
  isQualifiedLeadOutcome,
  QUALIFIED_LEAD_OUTCOMES,
  qualifiedLeadCampaignContactWhere,
  summarizeChannelAttribution,
  summarizeSmsEconomics,
} from "./analytics";

describe("SMS-first analytics filters", () => {
  it("builds one composable cohort for campaign and operational filters", () => {
    expect(
      buildAnalyticsCampaignContactWhere({
        campaignId: "campaign-1",
        source: "County List",
        state: "ga",
        county: "Cobb",
        status: "DELIVERED",
        classification: "INTERESTED",
        lead: "with_lead",
        export: "exported",
        stage: "QUALIFIED_LEAD",
        creditedChannel: "SMS",
      }),
    ).toEqual({
      AND: [
        { campaign: { is: { kind: "SMS" } } },
        { campaignId: "campaign-1" },
        {
          OR: [
            {
              campaign: {
                is: {
                  sourceName: {
                    contains: "County List",
                    mode: "insensitive",
                  },
                },
              },
            },
            {
              importRow: {
                is: {
                  mappedData: {
                    path: ["source"],
                    string_contains: "County List",
                    mode: "insensitive",
                  },
                },
              },
            },
            {
              property: {
                is: {
                  source: {
                    contains: "County List",
                    mode: "insensitive",
                  },
                },
              },
            },
            {
              contact: {
                is: {
                  source: {
                    contains: "County List",
                    mode: "insensitive",
                  },
                },
              },
            },
          ],
        },
        {
          property: {
            is: {
              state: { equals: "GA", mode: "insensitive" },
            },
          },
        },
        {
          property: {
            is: {
              county: { contains: "Cobb", mode: "insensitive" },
            },
          },
        },
        { outboundMessages: { some: { status: "DELIVERED" } } },
        { inboundMessages: { some: { classification: "INTERESTED" } } },
        {
          leadAttribution: {
            is: {
              qualifyingOutcome: { in: QUALIFIED_LEAD_OUTCOMES },
            },
          },
        },
        { leadAttribution: { is: { creditedChannel: "SMS" } } },
        {
          outreachSequence: {
            is: {
              AND: [
                { currentState: "QUALIFIED_LEAD" },
                { exportClaims: { some: { type: "BATCH_DIALER" } } },
              ],
            },
          },
        },
      ],
    });
  });

  it("supports an unexported BatchDialer eligibility cohort", () => {
    expect(buildAnalyticsCampaignContactWhere({ export: "eligible" })).toEqual({
      AND: [
        { campaign: { is: { kind: "SMS" } } },
        {
          outreachSequence: {
            is: {
              AND: [
                { currentState: "COLD_CALL_ELIGIBLE" },
                { exportClaims: { none: { type: "BATCH_DIALER" } } },
              ],
            },
          },
        },
      ],
    });
  });

  it("treats only qualified-or-later attribution outcomes as leads", () => {
    expect(qualifiedLeadCampaignContactWhere(true)).toEqual({
      leadAttribution: {
        is: { qualifyingOutcome: { in: QUALIFIED_LEAD_OUTCOMES } },
      },
    });
    expect(qualifiedLeadCampaignContactWhere(false)).toEqual({
      OR: [
        { leadAttribution: { is: null } },
        {
          leadAttribution: {
            is: {
              qualifyingOutcome: { notIn: QUALIFIED_LEAD_OUTCOMES },
            },
          },
        },
      ],
    });
    expect(isQualifiedLeadOutcome("INTERESTED")).toBe(false);
    expect(isQualifiedLeadOutcome("QUALIFIED_LEAD")).toBe(true);
    expect(isQualifiedLeadOutcome("CONTRACT")).toBe(true);
    expect(isQualifiedLeadOutcome("CLOSED")).toBe(true);
  });

  it("scopes operations inbound counts to SMS campaign contacts", () => {
    expect(
      buildSmsCampaignInboundWhere({
        classification: "INTERESTED",
      }),
    ).toEqual({
      AND: [
        {
          campaignContact: {
            is: { campaign: { is: { kind: "SMS" } } },
          },
        },
        { classification: "INTERESTED" },
      ],
    });
  });

  it("uses the lower configured or environment daily live cap", () => {
    expect(effectiveGlobalDailySmsCap(2_000, 10)).toBe(10);
    expect(effectiveGlobalDailySmsCap(8, 10)).toBe(8);
  });

  it("only combines provider costs with USD configuration when units agree", () => {
    expect(areSmsCostCurrenciesComparable([])).toBe(true);
    expect(areSmsCostCurrenciesComparable(["usd", "USD"])).toBe(true);
    expect(areSmsCostCurrenciesComparable(["EUR"])).toBe(false);
    expect(areSmsCostCurrenciesComparable(["USD", "EUR"])).toBe(false);
  });
});

describe("provider-neutral SMS economics", () => {
  it("uses provider actuals where known and estimates only as fallback", () => {
    expect(
      summarizeSmsEconomics({
        attempted: 4,
        accepted: 3,
        sent: 3,
        delivered: 2,
        replies: 1,
        interested: 1,
        qualified: 1,
        nonresponders: 2,
        batchDialerEligible: 1,
        batchDialerExported: 1,
        coldCallQualifiedLeads: 1,
        contracts: 1,
        closed: 0,
        outboundSegments: 6,
        inboundMessages: 2,
        configuredOutboundMessageCostMicros: 1_000,
        configuredSegmentCostMicros: 2_000,
        configuredInboundMessageCostMicros: 500,
        configuredFixedMonthlyCents: 100,
        estimatedOutboundCostMicros: 16_000,
        providerActualCostMicros: 9_000,
        estimatedFallbackCostMicros: 7_000,
        messagesWithActualCost: 2,
      }),
    ).toMatchObject({
      configuredOutboundCostMicros: 16_000,
      configuredInboundCostMicros: 1_000,
      configuredVariableCostMicros: 17_000,
      estimatedSnapshotCostMicros: 17_000,
      providerActualCostMicros: 9_000,
      estimatedFallbackCostMicros: 7_000,
      effectiveVariableCostMicros: 17_000,
      configuredVariableCostCents: 1.7,
      providerActualCostCents: 0.9,
      estimatedFallbackCostCents: 0.7,
      effectiveVariableCostCents: 1.7,
      configuredFixedMonthlyCents: 100,
      variableCostCents: 1.7,
      totalCostCents: 1.7,
      allInMonthlyRunRateCents: 101.7,
      messagesWithActualCost: 2,
      messagesUsingEstimatedCost: 2,
      providerActualCoverageRate: 50,
      costPerAttemptCents: 0.425,
      costPerDeliveredCents: 0.85,
      costPerReplyCents: 1.7,
      costPerClosedDealCents: null,
    });
  });

  it("returns null per-stage costs for empty denominators", () => {
    const result = summarizeSmsEconomics({
      attempted: 0,
      accepted: 0,
      sent: 0,
      delivered: 0,
      replies: 0,
      interested: 0,
      qualified: 0,
      nonresponders: 0,
      batchDialerEligible: 0,
      batchDialerExported: 0,
      coldCallQualifiedLeads: 0,
      contracts: 0,
      closed: 0,
      outboundSegments: 0,
      inboundMessages: 0,
      configuredOutboundMessageCostMicros: 0,
      configuredSegmentCostMicros: 0,
      configuredInboundMessageCostMicros: 0,
      configuredFixedMonthlyCents: 25,
      estimatedOutboundCostMicros: 0,
      providerActualCostMicros: 0,
      estimatedFallbackCostMicros: 0,
      messagesWithActualCost: 0,
    });

    expect(result.providerActualCoverageRate).toBe(0);
    expect(result.costPerAttemptCents).toBeNull();
    expect(result.costPerReplyCents).toBeNull();
    expect(result.costPerQualifiedLeadCents).toBeNull();
    expect(result.costPerClosedDealCents).toBeNull();
  });
});

describe("channel and calendar summaries", () => {
  it("does not promote an interested attribution to a qualified lead", () => {
    expect(QUALIFIED_LEAD_OUTCOMES).toEqual([
      "QUALIFIED_LEAD",
      "CONTRACT",
      "CLOSED",
    ]);
    expect(QUALIFIED_LEAD_OUTCOMES).not.toContain("INTERESTED");
  });

  it("never treats provider acceptance alone as a sent message", () => {
    expect(buildSentMessageLifecycleWhere()).toEqual({
      OR: [
        { sentAt: { not: null } },
        {
          status: {
            in: ["SENT", "DELIVERED", "UNDELIVERED", "REPLIED"],
          },
        },
      ],
    });
    const start = new Date("2026-09-14T04:00:00.000Z");
    const end = new Date("2026-09-15T04:00:00.000Z");
    expect(buildSentMessageLifecycleWhere({ start, end })).toEqual({
      sentAt: { gte: start, lt: end },
    });
  });

  it("keeps SMS and cold-call attribution explicit and folds unknowns into other", () => {
    expect(
      summarizeChannelAttribution([
        { creditedChannel: "SMS", _count: { _all: 4 } },
        { creditedChannel: "COLD_CALL", _count: { _all: 3 } },
        { creditedChannel: "OTHER", _count: { _all: 2 } },
        { creditedChannel: "future_channel", _count: { _all: 1 } },
      ]),
    ).toEqual({ sms: 4, coldCall: 3, other: 3 });
  });

  it("creates DST-aware local-day bounds and rejects impossible dates", () => {
    const day = analyticsDateRange("2026-03-08", "America/New_York");
    expect(day.key).toBe("2026-03-08");
    expect(day.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(day.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(day.storageDate.toISOString()).toBe("2026-03-08T00:00:00.000Z");
    expect(() => analyticsDateRange("2026-02-30", "America/New_York")).toThrow(
      "Analytics date is invalid",
    );
  });
});
