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

export interface DropCowboyBillingInput {
  successfulRvmCount: number;
  monthlyMinimumCents: number;
  successCostCents: number;
  actualInvoiceCents?: number | null;
}

export function calculateDropCowboyBilling(input: DropCowboyBillingInput) {
  const successfulRvmCount = Math.max(0, Math.trunc(input.successfulRvmCount));
  const monthlyMinimumCents = Math.max(
    0,
    Math.round(input.monthlyMinimumCents),
  );
  const usageValueCents = Math.round(
    successfulRvmCount * Math.max(0, input.successCostCents),
  );
  const calculatedInvoiceCents = Math.max(monthlyMinimumCents, usageValueCents);
  const invoiceCents =
    input.actualInvoiceCents == null
      ? calculatedInvoiceCents
      : Math.max(0, Math.round(input.actualInvoiceCents));
  return {
    successfulRvmCount,
    usageValueCents,
    monthlyMinimumCents,
    calculatedInvoiceCents,
    invoiceCents,
    unusedMinimumCreditCents: Math.max(
      0,
      monthlyMinimumCents - usageValueCents,
    ),
  };
}

export function allocateSharedCost(
  totalCents: number,
  unitsByKey: Record<string, number>,
) {
  const cents = Math.max(0, Math.round(totalCents));
  const entries = Object.entries(unitsByKey)
    .map(([key, units]) => [key, Math.max(0, units)] as const)
    .filter(([, units]) => units > 0);
  const totalUnits = entries.reduce((sum, [, units]) => sum + units, 0);
  if (totalUnits === 0)
    return {
      allocations: {} as Record<string, number>,
      unallocatedCents: cents,
    };
  const provisional = entries.map(([key, units]) => {
    const exact = (cents * units) / totalUnits;
    return {
      key,
      floor: Math.floor(exact),
      fraction: exact - Math.floor(exact),
    };
  });
  let remaining =
    cents - provisional.reduce((sum, allocation) => sum + allocation.floor, 0);
  provisional.sort(
    (left, right) =>
      right.fraction - left.fraction || left.key.localeCompare(right.key),
  );
  const allocations: Record<string, number> = {};
  for (const allocation of provisional) {
    allocations[allocation.key] = allocation.floor + (remaining-- > 0 ? 1 : 0);
  }
  return { allocations, unallocatedCents: 0 };
}

export interface CarrierCostInput {
  attemptedRvmCount: number;
  attemptsWithActualDuration: number;
  actualDurationSeconds: number;
  averageSecondsPerAttempt: number;
  trunkMonthlyCents: number;
  didMonthlyCents: number;
  activeDidCount: number;
  voiceCentsPerMinute: number;
}

export function calculateCarrierCosts(input: CarrierCostInput) {
  const attempted = Math.max(0, Math.trunc(input.attemptedRvmCount));
  const actualAttempts = Math.min(
    attempted,
    Math.max(0, Math.trunc(input.attemptsWithActualDuration)),
  );
  const estimatedAttempts = attempted - actualAttempts;
  const actualSeconds = Math.max(0, input.actualDurationSeconds);
  const estimatedSeconds =
    estimatedAttempts * Math.max(0, input.averageSecondsPerAttempt);
  const totalSeconds = actualSeconds + estimatedSeconds;
  const fixedCents = Math.round(
    Math.max(0, input.trunkMonthlyCents) +
      Math.max(0, input.didMonthlyCents) *
        Math.max(0, Math.trunc(input.activeDidCount)),
  );
  const variableCents = Math.round(
    (totalSeconds / 60) * Math.max(0, input.voiceCentsPerMinute),
  );
  return {
    fixedCents,
    variableCents,
    totalCents: fixedCents + variableCents,
    actualSeconds,
    estimatedSeconds,
    totalSeconds,
    durationBasis:
      attempted === 0 || actualAttempts === attempted
        ? ("ACTUAL" as const)
        : actualAttempts === 0
          ? ("ESTIMATED" as const)
          : ("MIXED" as const),
  };
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
