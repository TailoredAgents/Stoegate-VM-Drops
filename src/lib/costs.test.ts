import { describe, expect, it } from "vitest";
import {
  allocateSharedCost,
  calculateCampaignCosts,
  calculateCarrierCosts,
  calculateDropCowboyBilling,
  calculateVABenchmarks,
} from "./costs";

describe("campaign and VA costs", () => {
  it("uses integer cents and protects zero denominators", () => {
    const result = calculateCampaignCosts({
      characterCount: 10_000,
      deliveredDrops: 100,
      attemptedDrops: 110,
      callbacks: 5,
      interested: 2,
      qualifiedLeads: 1,
      closedDeals: 0,
      revenueCents: 0,
      elevenLabsCentsPerThousandCharacters: 30,
      rvmCentsPerDeliveredDrop: 9,
      complianceCentsPerMessage: 1,
    });
    expect(result).toMatchObject({
      ttsCents: 300,
      rvmCents: 900,
      complianceCents: 110,
      totalCents: 1310,
      costPerDeliveredCents: 13,
      costPerCallbackCents: 262,
      costPerInterestedCents: 655,
      costPerQualifiedLeadCents: 1310,
      actualCostPerClosedDealCents: null,
    });
    expect(
      calculateCampaignCosts({
        characterCount: 10_000,
        deliveredDrops: 100,
        attemptedDrops: 110,
        callbacks: 5,
        interested: 2,
        qualifiedLeads: 1,
        closedDeals: 2,
        revenueCents: 0,
        elevenLabsCentsPerThousandCharacters: 30,
        rvmCentsPerDeliveredDrop: 9,
        complianceCentsPerMessage: 1,
      }).actualCostPerClosedDealCents,
    ).toBe(655);
  });

  it("calculates the supplied Stonegate VA defaults", () => {
    expect(
      calculateVABenchmarks(
        {
          hourlyRateCents: 700,
          realConversationsPerHour: 6,
          realConversationsPerLead: 40,
          leadsPerDeal: 15,
        },
        10,
      ),
    ).toEqual({
      vaCostPerConversationCents: 700 / 6,
      vaCostPerQualifiedLeadCents: 4667,
      vaExpectedLaborCostPerDealCents: 70000,
      vaEquivalentConversations: 400,
    });
  });
});

describe("account-specific provider economics", () => {
  it("treats the Drop Cowboy quote as a minimum credit, not fee plus usage", () => {
    expect(
      calculateDropCowboyBilling({
        successfulRvmCount: 10_000,
        monthlyMinimumCents: 25_000,
        successCostCents: 1,
      }),
    ).toMatchObject({
      usageValueCents: 10_000,
      invoiceCents: 25_000,
      unusedMinimumCreditCents: 15_000,
    });
    expect(
      calculateDropCowboyBilling({
        successfulRvmCount: 25_001,
        monthlyMinimumCents: 25_000,
        successCostCents: 1,
      }),
    ).toMatchObject({
      usageValueCents: 25_001,
      invoiceCents: 25_001,
      unusedMinimumCreditCents: 0,
    });
  });

  it("allocates one shared minimum exactly across campaigns", () => {
    expect(
      allocateSharedCost(25_000, { campaign_a: 1_000, campaign_b: 3_000 }),
    ).toEqual({
      allocations: { campaign_a: 6_250, campaign_b: 18_750 },
      unallocatedCents: 0,
    });
    const thirds = allocateSharedCost(100, { a: 1, b: 1, c: 1 });
    expect(Object.values(thirds.allocations).reduce((a, b) => a + b, 0)).toBe(
      100,
    );
    expect(allocateSharedCost(25_000, {})).toEqual({
      allocations: {},
      unallocatedCents: 25_000,
    });
  });

  it("calculates generic carrier fixed and estimated variable costs", () => {
    expect(
      calculateCarrierCosts({
        attemptedRvmCount: 2_000,
        attemptsWithActualDuration: 0,
        actualDurationSeconds: 0,
        averageSecondsPerAttempt: 30,
        trunkMonthlyCents: 1_500,
        didMonthlyCents: 115,
        activeDidCount: 1,
        voiceCentsPerMinute: 0.66,
      }),
    ).toMatchObject({
      fixedCents: 1_615,
      variableCents: 660,
      totalCents: 2_275,
      estimatedSeconds: 60_000,
      durationBasis: "ESTIMATED",
    });
  });
});
