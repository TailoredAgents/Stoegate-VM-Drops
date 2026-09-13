import type { CallbackOutcomeType } from "@prisma/client";
import { db } from "@/lib/db";
import {
  calculateBreakEvenCallbackRate,
  calculateCampaignCosts,
  calculateVABenchmarks,
} from "@/lib/costs";
import { getNumericSettings } from "@/lib/settings";
import { percent } from "@/lib/utils";

export async function getCampaignMetrics(campaignId?: string) {
  const settings = await getNumericSettings();
  const campaignWhere = campaignId ? { campaignId } : {};
  const [campaigns, contactGroups, dropGroups, audio, outcomeGroups, revenue] =
    await Promise.all([
      db.campaign.aggregate({
        where: campaignId ? { id: campaignId } : {},
        _sum: {
          uploadedCount: true,
          eligibleCount: true,
          invalidCount: true,
          duplicateCount: true,
          suppressedCount: true,
        },
      }),
      db.campaignContact.groupBy({
        by: ["status"],
        where: campaignWhere,
        _count: { _all: true },
      }),
      db.drop.groupBy({
        by: ["status"],
        where: { campaignContact: campaignWhere },
        _count: { _all: true },
      }),
      db.audioAsset.aggregate({
        where: { campaignContact: campaignWhere },
        _sum: { characterCount: true },
        _count: { _all: true },
      }),
      db.callbackOutcome.groupBy({
        by: ["outcome"],
        where: campaignId ? { campaignId } : {},
        _count: { _all: true },
      }),
      db.callbackOutcome.aggregate({
        where: campaignId ? { campaignId } : {},
        _sum: { revenueCents: true },
      }),
    ]);

  const dropCount = (status: string) =>
    dropGroups.find((row) => row.status === status)?._count._all ?? 0;
  const outcomeCount = (status: CallbackOutcomeType) =>
    outcomeGroups.find((row) => row.outcome === status)?._count._all ?? 0;
  const delivered = dropCount("DELIVERED");
  const failed = dropCount("FAILED");
  const queued = dropCount("QUEUED") + dropCount("SENT") + dropCount("PENDING");
  const callbacks = outcomeGroups.reduce(
    (sum, row) => sum + row._count._all,
    0,
  );
  const interested =
    outcomeCount("INTERESTED") +
    outcomeCount("QUALIFIED_LEAD") +
    outcomeCount("CONTRACT") +
    outcomeCount("CLOSED");
  const qualified =
    outcomeCount("QUALIFIED_LEAD") +
    outcomeCount("CONTRACT") +
    outcomeCount("CLOSED");
  const contracts = outcomeCount("CONTRACT") + outcomeCount("CLOSED");
  const closed = outcomeCount("CLOSED");
  const attemptedDrops = dropGroups.reduce(
    (sum, row) => sum + row._count._all,
    0,
  );
  const costs = calculateCampaignCosts({
    characterCount: audio._sum.characterCount ?? 0,
    deliveredDrops: delivered,
    attemptedDrops,
    callbacks,
    interested,
    qualifiedLeads: qualified,
    closedDeals: closed,
    revenueCents: revenue._sum.revenueCents ?? 0,
    elevenLabsCentsPerThousandCharacters:
      settings.elevenlabs_cost_per_1000_chars_cents,
    rvmCentsPerDeliveredDrop: settings.rvm_cost_per_delivered_drop_cents,
    complianceCentsPerMessage: settings.compliance_cost_per_message_cents,
  });
  const va = calculateVABenchmarks(
    {
      hourlyRateCents: settings.va_hourly_rate_cents,
      realConversationsPerHour: settings.va_real_conversations_per_hour,
      realConversationsPerLead: settings.va_real_conversations_per_lead,
      leadsPerDeal: settings.va_leads_per_deal,
    },
    qualified,
  );
  const qualifiedPerCallback = callbacks > 0 ? qualified / callbacks : 0;
  return {
    uploaded: campaigns._sum.uploadedCount ?? 0,
    eligible: campaigns._sum.eligibleCount ?? 0,
    suppressed: campaigns._sum.suppressedCount ?? 0,
    invalid: campaigns._sum.invalidCount ?? 0,
    duplicate: campaigns._sum.duplicateCount ?? 0,
    audioGenerated: audio._count._all,
    queued,
    delivered,
    failed,
    deliveryRate: percent(delivered, delivered + failed),
    callbacks,
    callbackRate: percent(callbacks, delivered),
    interested,
    interestedCallbackRate: percent(interested, callbacks),
    qualified,
    callbackToQualifiedRate: percent(qualified, callbacks),
    contracts,
    closed,
    revenueCents: revenue._sum.revenueCents ?? 0,
    expectedDeals: qualified / settings.va_leads_per_deal,
    ...costs,
    ...va,
    costPerExpectedDealCents:
      qualified > 0
        ? Math.round(
            costs.totalCents / (qualified / settings.va_leads_per_deal),
          )
        : null,
    rvmVsVaCostPerLeadDifferenceCents:
      costs.costPerQualifiedLeadCents == null
        ? null
        : va.vaCostPerQualifiedLeadCents - costs.costPerQualifiedLeadCents,
    breakEvenCallbackRate: calculateBreakEvenCallbackRate(
      costs.totalCents,
      delivered,
      va.vaCostPerQualifiedLeadCents,
      qualifiedPerCallback,
    ),
    contactStatusCounts: Object.fromEntries(
      contactGroups.map((row) => [row.status, row._count._all]),
    ),
  };
}
