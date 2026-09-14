export interface VABenchmarks {
  hourlyRateCents: number;
  realConversationsPerHour: number;
  realConversationsPerLead: number;
  leadsPerDeal: number;
}

export interface SmsCostInputs {
  sentMessages: number;
  deliveredMessages: number;
  outboundSegments: number;
  inboundMessages: number;
  replies: number;
  interested: number;
  qualifiedLeads: number;
  contracts: number;
  closedDeals: number;
  revenueCents: number;
  costPerOutboundMessageMicros: number;
  costPerSegmentMicros: number;
  costPerInboundMessageMicros: number;
  providerActualVariableCostMicros?: number | null;
  fixedMonthlyProviderFeeCents: number;
  phoneNumberMonthlyCostCents: number;
  registrationMonthlyCostCents: number;
  infrastructureMonthlyCostCents?: number;
}

function nonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function count(value: number) {
  return Math.max(0, Math.trunc(nonNegative(value)));
}

function perUnit(totalCents: number, denominator: number): number | null {
  return denominator > 0 ? totalCents / denominator : null;
}

export function calculateSmsCampaignCosts(input: SmsCostInputs) {
  const sent = count(input.sentMessages);
  const delivered = count(input.deliveredMessages);
  const segments = count(input.outboundSegments);
  const inbound = count(input.inboundMessages);
  const estimatedVariableCostMicros =
    sent * nonNegative(input.costPerOutboundMessageMicros) +
    segments * nonNegative(input.costPerSegmentMicros) +
    inbound * nonNegative(input.costPerInboundMessageMicros);
  const providerVariableCostMicros =
    input.providerActualVariableCostMicros == null
      ? estimatedVariableCostMicros
      : nonNegative(input.providerActualVariableCostMicros);
  const fixedCostCents =
    nonNegative(input.fixedMonthlyProviderFeeCents) +
    nonNegative(input.phoneNumberMonthlyCostCents) +
    nonNegative(input.registrationMonthlyCostCents) +
    nonNegative(input.infrastructureMonthlyCostCents ?? 0);
  const variableCostCents = providerVariableCostMicros / 10_000;
  const totalCents = fixedCostCents + variableCostCents;

  return {
    sent,
    delivered,
    segments,
    inbound,
    estimatedVariableCostMicros,
    providerVariableCostMicros,
    usedProviderActualCost: input.providerActualVariableCostMicros != null,
    fixedCostCents,
    variableCostCents,
    totalCents,
    costPerSentCents: perUnit(totalCents, sent),
    costPerDeliveredCents: perUnit(totalCents, delivered),
    costPerReplyCents: perUnit(totalCents, count(input.replies)),
    costPerInterestedCents: perUnit(totalCents, count(input.interested)),
    costPerQualifiedLeadCents: perUnit(totalCents, count(input.qualifiedLeads)),
    costPerContractCents: perUnit(totalCents, count(input.contracts)),
    costPerClosedDealCents: perUnit(totalCents, count(input.closedDeals)),
    roiPercent:
      totalCents > 0
        ? ((nonNegative(input.revenueCents) - totalCents) / totalCents) * 100
        : null,
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
      Math.max(0, qualifiedLeads) * benchmark.realConversationsPerLead,
  };
}
