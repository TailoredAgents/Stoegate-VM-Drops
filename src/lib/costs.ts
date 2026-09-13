export interface CostInputs {
  characterCount: number;
  deliveredDrops: number;
  attemptedDrops: number;
  callbacks: number;
  interested: number;
  qualifiedLeads: number;
  closedDeals: number;
  revenueCents: number;
  elevenLabsCentsPerThousandCharacters: number;
  rvmCentsPerDeliveredDrop: number;
  complianceCentsPerMessage: number;
}

export interface VABenchmarks {
  hourlyRateCents: number;
  realConversationsPerHour: number;
  realConversationsPerLead: number;
  leadsPerDeal: number;
}

function perUnit(total: number, count: number): number | null {
  return count > 0 ? Math.round(total / count) : null;
}

export function calculateCampaignCosts(input: CostInputs) {
  const tts = Math.round(
    (input.characterCount / 1000) * input.elevenLabsCentsPerThousandCharacters,
  );
  const rvm = input.deliveredDrops * input.rvmCentsPerDeliveredDrop;
  const compliance = input.attemptedDrops * input.complianceCentsPerMessage;
  const total = tts + rvm + compliance;
  return {
    ttsCents: tts,
    rvmCents: rvm,
    complianceCents: compliance,
    totalCents: total,
    costPerDeliveredCents: perUnit(total, input.deliveredDrops),
    costPerCallbackCents: perUnit(total, input.callbacks),
    costPerInterestedCents: perUnit(total, input.interested),
    costPerQualifiedLeadCents: perUnit(total, input.qualifiedLeads),
    actualCostPerClosedDealCents: perUnit(total, input.closedDeals),
    roiPercent: total > 0 ? ((input.revenueCents - total) / total) * 100 : null,
  };
}

export function calculateVABenchmarks(
  benchmark: VABenchmarks,
  qualifiedLeads = 0,
) {
  const costPerConversation =
    benchmark.hourlyRateCents / benchmark.realConversationsPerHour;
  const costPerLead =
    (benchmark.hourlyRateCents * benchmark.realConversationsPerLead) /
    benchmark.realConversationsPerHour;
  const costPerDeal = costPerLead * benchmark.leadsPerDeal;
  return {
    vaCostPerConversationCents: costPerConversation,
    vaCostPerQualifiedLeadCents: Math.round(costPerLead),
    vaExpectedLaborCostPerDealCents: Math.round(costPerDeal),
    vaEquivalentConversations:
      qualifiedLeads * benchmark.realConversationsPerLead,
  };
}

export function calculateBreakEvenCallbackRate(
  totalCampaignCostCents: number,
  delivered: number,
  vaCostPerQualifiedLeadCents: number,
  qualifiedPerCallbackRate: number,
): number | null {
  if (
    delivered <= 0 ||
    vaCostPerQualifiedLeadCents <= 0 ||
    qualifiedPerCallbackRate <= 0
  )
    return null;
  const requiredCallbacks =
    totalCampaignCostCents /
    (vaCostPerQualifiedLeadCents * qualifiedPerCallbackRate);
  return requiredCallbacks / delivered;
}
