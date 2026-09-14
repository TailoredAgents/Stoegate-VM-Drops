import { describe, expect, it } from "vitest";
import { calculateSmsCampaignCosts, calculateVABenchmarks } from "./costs";

describe("SMS campaign economics", () => {
  const base = {
    sentMessages: 2_000,
    deliveredMessages: 1_900,
    outboundSegments: 2_100,
    inboundMessages: 100,
    replies: 100,
    interested: 10,
    qualifiedLeads: 4,
    contracts: 1,
    closedDeals: 0,
    revenueCents: 0,
    costPerOutboundMessageMicros: 2_500,
    costPerSegmentMicros: 7_900,
    costPerInboundMessageMicros: 1_000,
    fixedMonthlyProviderFeeCents: 2_000,
    phoneNumberMonthlyCostCents: 150,
    registrationMonthlyCostCents: 1_000,
    infrastructureMonthlyCostCents: 0,
  };

  it("combines configuration-driven variable and fixed costs", () => {
    const result = calculateSmsCampaignCosts(base);
    expect(result).toMatchObject({
      estimatedVariableCostMicros: 21_690_000,
      providerVariableCostMicros: 21_690_000,
      usedProviderActualCost: false,
      fixedCostCents: 3_150,
      variableCostCents: 2_169,
      totalCents: 5_319,
      costPerSentCents: 2.6595,
      costPerReplyCents: 53.19,
      costPerQualifiedLeadCents: 1_329.75,
      costPerClosedDealCents: null,
    });
  });

  it("uses a provider-supplied actual variable-cost override", () => {
    expect(
      calculateSmsCampaignCosts({
        ...base,
        providerActualVariableCostMicros: 25_000_000,
      }),
    ).toMatchObject({
      providerVariableCostMicros: 25_000_000,
      usedProviderActualCost: true,
      variableCostCents: 2_500,
      totalCents: 5_650,
    });
  });
});

describe("VA benchmark", () => {
  it("keeps the editable Stonegate benchmark math", () => {
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
