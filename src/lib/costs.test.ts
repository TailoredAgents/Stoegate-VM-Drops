import { describe, expect, it } from "vitest";
import { calculateCampaignCosts, calculateVABenchmarks } from "./costs";

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
