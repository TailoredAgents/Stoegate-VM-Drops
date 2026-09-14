import {
  type AttributionChannel,
  Prisma,
  type OutreachSequenceState,
} from "@prisma/client";
import { getAttributableOutreachCosts } from "@/lib/billing-economics";
import { db } from "@/lib/db";
import {
  calculateBreakEvenCallbackRate,
  calculateVABenchmarks,
} from "@/lib/costs";
import { campaignSpecificSourceFilter } from "@/lib/outreach-exports";
import { getDailyRvmUsage } from "@/lib/rvm-operations";
import { getAppSettings } from "@/lib/settings";
import { getLocalDayBounds, zonedDateTimeToUtc } from "@/lib/time";
import { percent } from "@/lib/utils";

function perUnit(total: number, count: number): number | null {
  return count > 0 ? Math.round(total / count) : null;
}

function outcomeIdentity(outcome: {
  campaignContactId: string | null;
  normalizedPhone: string;
}) {
  return outcome.campaignContactId ?? outcome.normalizedPhone;
}

export interface AttributedOutcomeObservation {
  campaignContactId: string | null;
  outcome: string;
  attributionChannel: AttributionChannel;
  creditedRvmCallback?: boolean;
}

function normalizedOutcome(value: string) {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function isQualifiedOutcome(value: string) {
  return ["QUALIFIED", "QUALIFIED_LEAD", "CONTRACT", "CLOSED"].includes(
    normalizedOutcome(value),
  );
}

const QUALIFIED_SEQUENCE_STATES: OutreachSequenceState[] = [
  "QUALIFIED_LEAD",
  "CONTRACT",
  "CLOSED",
];

export function countQualifiedAttributionsByChannel(
  attributions: Array<{
    campaignContactId: string;
    creditedChannel: AttributionChannel;
  }>,
  qualifyingCampaignContactIds: Iterable<string>,
) {
  const qualifying = new Set(qualifyingCampaignContactIds);
  const result: Record<AttributionChannel, number> = {
    RVM_CALLBACK: 0,
    SMS: 0,
    COLD_CALL: 0,
    OTHER: 0,
  };
  for (const attribution of attributions) {
    if (qualifying.has(attribution.campaignContactId))
      result[attribution.creditedChannel] += 1;
  }
  return result;
}

export function summarizeAttributedOutcomeStages(
  observations: AttributedOutcomeObservation[],
) {
  const callbacks = new Set<string>();
  const interested = new Set<string>();
  const qualified = new Set<string>();
  const contracts = new Set<string>();
  const closed = new Set<string>();
  for (const observation of observations) {
    const id = observation.campaignContactId;
    if (!id) continue;
    if (
      observation.creditedRvmCallback &&
      observation.attributionChannel === "RVM_CALLBACK"
    ) {
      callbacks.add(id);
    }
    const outcome = normalizedOutcome(observation.outcome);
    if (
      [
        "INTERESTED",
        "QUALIFIED",
        "QUALIFIED_LEAD",
        "CONTRACT",
        "CLOSED",
      ].includes(outcome)
    )
      interested.add(id);
    if (["QUALIFIED", "QUALIFIED_LEAD", "CONTRACT", "CLOSED"].includes(outcome))
      qualified.add(id);
    if (["CONTRACT", "CLOSED"].includes(outcome)) contracts.add(id);
    if (outcome === "CLOSED") closed.add(id);
  }
  return {
    callbacks: callbacks.size,
    interested: interested.size,
    qualified: qualified.size,
    contracts: contracts.size,
    closed: closed.size,
  };
}

export async function getCampaignMetrics(campaignId?: string) {
  const settings = await getAppSettings();
  const campaignWhere = campaignId ? { campaignId } : {};
  const [
    campaigns,
    contactGroups,
    dropGroups,
    outcomes,
    externalOutcomeEvents,
    leadAttributions,
    revenue,
    costs,
  ] = await Promise.all([
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
    db.callbackOutcome.findMany({
      where: campaignId ? { campaignId } : {},
      select: {
        campaignContactId: true,
        normalizedPhone: true,
        outcome: true,
        attributionChannel: true,
      },
    }),
    db.outreachEvent.findMany({
      where: {
        channel: { in: ["SMS", "COLD_CALL"] },
        source: "external_outcome_import",
        type: { not: "SEQUENCE_EXITED" },
        outcome: { not: null },
        ...(campaignId
          ? { sequence: { campaignContact: { campaignId } } }
          : {}),
      },
      select: {
        channel: true,
        outcome: true,
        sequence: { select: { campaignContactId: true } },
      },
    }),
    db.leadAttribution.findMany({
      where: campaignId ? { campaignId } : undefined,
      select: {
        campaignContactId: true,
        creditedChannel: true,
        qualifyingOutcome: true,
      },
    }),
    db.callbackOutcome.aggregate({
      where: campaignId ? { campaignId } : {},
      _sum: { revenueCents: true },
    }),
    getAttributableOutreachCosts(campaignId),
  ]);

  const dropCount = (status: string) =>
    dropGroups.find((row) => row.status === status)?._count._all ?? 0;
  const stageObservations: AttributedOutcomeObservation[] = [
    ...outcomes.map((outcome) => ({
      campaignContactId: outcome.campaignContactId,
      outcome: outcome.outcome,
      attributionChannel: outcome.attributionChannel,
      creditedRvmCallback: outcome.attributionChannel === "RVM_CALLBACK",
    })),
    ...externalOutcomeEvents.flatMap((event) =>
      event.outcome
        ? [
            {
              campaignContactId: event.sequence.campaignContactId,
              outcome: event.outcome,
              attributionChannel: event.channel as AttributionChannel,
            },
          ]
        : [],
    ),
    ...leadAttributions.map((attribution) => ({
      campaignContactId: attribution.campaignContactId,
      outcome: attribution.qualifyingOutcome,
      attributionChannel: attribution.creditedChannel,
    })),
  ];
  const stages = summarizeAttributedOutcomeStages(stageObservations);
  const rvmStages = summarizeAttributedOutcomeStages(
    stageObservations.filter(
      (observation) => observation.attributionChannel === "RVM_CALLBACK",
    ),
  );
  const delivered = costs.successful;
  const failed = dropCount("FAILED");
  const queued = dropCount("QUEUED") + dropCount("SENT") + dropCount("PENDING");
  const { callbacks, interested, qualified, contracts, closed } = stages;
  const totalCents = costs.totalAttributableCents;
  const revenueCents = revenue._sum.revenueCents ?? 0;
  const va = calculateVABenchmarks(
    {
      hourlyRateCents: settings.va_hourly_rate_cents,
      realConversationsPerHour: settings.va_real_conversations_per_hour,
      realConversationsPerLead: settings.va_real_conversations_per_lead,
      leadsPerDeal: settings.va_leads_per_deal,
    },
    qualified,
  );
  const qualifiedPerCallback =
    callbacks > 0 ? rvmStages.qualified / callbacks : 0;
  return {
    uploaded: campaigns._sum.uploadedCount ?? 0,
    eligible: campaigns._sum.eligibleCount ?? 0,
    suppressed: campaigns._sum.suppressedCount ?? 0,
    invalid: campaigns._sum.invalidCount ?? 0,
    duplicate: campaigns._sum.duplicateCount ?? 0,
    audioGenerated: costs.generatedAudioCount,
    audioReuseCount: costs.audioReuseCount,
    elevenLabsCharacters: costs.elevenLabsCharacters,
    queued,
    attempted: costs.attempted,
    delivered,
    failed,
    deliveryRate: percent(delivered, delivered + failed),
    rvmSuccessRate: costs.rvmSuccessRate,
    callbacks,
    callbackRate: percent(callbacks, delivered),
    interested,
    interestedCallbackRate: percent(rvmStages.interested, callbacks),
    qualified,
    callbackToQualifiedRate: percent(rvmStages.qualified, callbacks),
    contracts,
    closed,
    revenueCents,
    expectedDeals: qualified / settings.va_leads_per_deal,
    ttsCents: costs.elevenLabsCents,
    rvmCents: costs.allocatedDropCowboyCents,
    marginalDropCowboyCents: costs.marginalDropCowboyCents,
    allocatedDropCowboyCents: costs.allocatedDropCowboyCents,
    carrierFixedCents: costs.carrierFixedCents,
    carrierVariableCents: costs.carrierVariableCents,
    carrierTotalCents: costs.carrierTotalCents,
    infrastructureCents: costs.infrastructureCents,
    complianceCents: 0,
    totalCents,
    costPerAttemptedCents: perUnit(totalCents, costs.attempted),
    costPerDeliveredCents: perUnit(totalCents, delivered),
    costPerCallbackCents: perUnit(totalCents, callbacks),
    costPerInterestedCents: perUnit(totalCents, interested),
    costPerQualifiedLeadCents: perUnit(totalCents, qualified),
    costPerContractCents: perUnit(totalCents, contracts),
    actualCostPerClosedDealCents: perUnit(totalCents, closed),
    roiPercent:
      totalCents > 0 ? ((revenueCents - totalCents) / totalCents) * 100 : null,
    ...va,
    costPerExpectedDealCents:
      qualified > 0
        ? Math.round(totalCents / (qualified / settings.va_leads_per_deal))
        : null,
    rvmVsVaCostPerLeadDifferenceCents:
      qualified === 0
        ? null
        : va.vaCostPerQualifiedLeadCents - Math.round(totalCents / qualified),
    breakEvenCallbackRate: calculateBreakEvenCallbackRate(
      totalCents,
      delivered,
      va.vaCostPerQualifiedLeadCents,
      qualifiedPerCallback,
    ),
    contactStatusCounts: Object.fromEntries(
      contactGroups.map((row) => [row.status, row._count._all]),
    ),
  };
}

export async function getOutreachFunnel(campaignId?: string) {
  const [events, states, attributions, attributedCallbackOutcomes] =
    await Promise.all([
      db.outreachEvent.findMany({
        where: campaignId
          ? { sequence: { campaignContact: { campaignId } } }
          : undefined,
        select: {
          sequenceId: true,
          type: true,
          channel: true,
          source: true,
          resultingState: true,
          sequence: { select: { campaignContactId: true } },
        },
      }),
      db.outreachSequence.groupBy({
        by: ["currentState"],
        where: campaignId ? { campaignContact: { campaignId } } : undefined,
        _count: { _all: true },
      }),
      db.leadAttribution.findMany({
        where: campaignId ? { campaignId } : undefined,
        select: { campaignContactId: true, creditedChannel: true },
      }),
      db.callbackOutcome.findMany({
        where: {
          campaignContactId: { not: null },
          ...(campaignId ? { campaignId } : {}),
        },
        select: {
          campaignContactId: true,
          attributionChannel: true,
          outcome: true,
        },
      }),
    ]);
  const eventCount = (
    types: Array<(typeof events)[number]["type"]>,
    channel?: (typeof events)[number]["channel"],
  ) =>
    new Set(
      events
        .filter(
          (event) =>
            types.includes(event.type) &&
            (!channel || event.channel === channel),
        )
        .map((event) => event.sequenceId),
    ).size;
  const qualifyingCampaignContacts = new Set([
    ...attributedCallbackOutcomes.flatMap((outcome) =>
      outcome.campaignContactId && isQualifiedOutcome(outcome.outcome)
        ? [outcome.campaignContactId]
        : [],
    ),
    ...events.flatMap((event) =>
      ["SMS", "COLD_CALL"].includes(event.channel) &&
      event.source === "external_outcome_import" &&
      event.type !== "SEQUENCE_EXITED" &&
      QUALIFIED_SEQUENCE_STATES.includes(event.resultingState)
        ? [event.sequence.campaignContactId]
        : [],
    ),
  ]);
  const qualifiedByChannel = countQualifiedAttributionsByChannel(
    attributions,
    qualifyingCampaignContacts,
  );
  const rvmCallbackCount = new Set(
    attributedCallbackOutcomes.flatMap((outcome) =>
      outcome.campaignContactId && outcome.attributionChannel === "RVM_CALLBACK"
        ? [outcome.campaignContactId]
        : [],
    ),
  ).size;
  const coldCallContacted = new Set(
    events
      .filter(
        (event) =>
          event.channel === "COLD_CALL" &&
          event.source === "external_outcome_import" &&
          (event.type === "COLD_CALL_CONTACTED" ||
            (event.type === "OUTCOME_RECORDED" &&
              [
                "INTERESTED",
                "QUALIFIED_LEAD",
                "FOLLOW_UP",
                "NOT_INTERESTED",
                "OPT_OUT",
                "CONTRACT",
                "CLOSED",
              ].includes(event.resultingState))),
      )
      .map((event) => event.sequenceId),
  ).size;
  return {
    rvm: {
      attempted: eventCount(["RVM_SENT"]),
      successful: eventCount(["RVM_SUCCESS"]),
      callbacks: rvmCallbackCount,
      qualifiedLeads: qualifiedByChannel.RVM_CALLBACK,
    },
    sms: {
      eligible: eventCount(["SMS_ELIGIBLE"]),
      exported: eventCount(["SMS_EXPORTED"]),
      sent: eventCount(["SMS_SENT_EXTERNAL"]),
      replies: eventCount(["SMS_REPLIED", "OUTCOME_RECORDED"], "SMS"),
      qualifiedLeads: qualifiedByChannel.SMS,
    },
    coldCall: {
      eligible: eventCount(["COLD_CALL_ELIGIBLE"]),
      exported: eventCount(["COLD_CALL_EXPORTED"]),
      contacted: coldCallContacted,
      qualifiedLeads: qualifiedByChannel.COLD_CALL,
    },
    otherQualifiedLeads: qualifiedByChannel.OTHER,
    stateCounts: Object.fromEntries(
      states.map((row) => [row.currentState, row._count._all]),
    ) as Partial<Record<OutreachSequenceState, number>>,
  };
}

export interface TodayOperationsFilters {
  campaignId?: string;
  stage?: OutreachSequenceState;
  source?: string;
  responseChannel?: AttributionChannel;
  date?: string;
}

function responseEventFilter(
  channel: AttributionChannel,
): Prisma.OutreachEventWhereInput {
  if (channel === "RVM_CALLBACK")
    return {
      channel: "RVM",
      type: { in: ["RVM_CALLBACK", "OUTCOME_RECORDED"] },
    };
  if (channel === "SMS")
    return {
      channel: "SMS",
      type: { in: ["SMS_REPLIED", "OUTCOME_RECORDED"] },
    };
  if (channel === "COLD_CALL")
    return {
      channel: "COLD_CALL",
      type: {
        in: ["COLD_CALL_CONTACTED", "COLD_CALL_NO_ANSWER", "OUTCOME_RECORDED"],
      },
    };
  return { channel: "SYSTEM", type: "OUTCOME_RECORDED" };
}

export async function getTodayOperations(filters: TodayOperationsFilters = {}) {
  const settings = await getAppSettings();
  let at = new Date();
  if (filters.date && /^\d{4}-\d{2}-\d{2}$/.test(filters.date)) {
    const [year, month, day] = filters.date.split("-").map(Number);
    at = zonedDateTimeToUtc(
      { year, month, day, hour: 12, minute: 0 },
      settings.operations_timezone,
    );
  }
  const day = getLocalDayBounds(at, settings.operations_timezone);
  const campaignContactFilters: Prisma.CampaignContactWhereInput[] = [];
  if (filters.campaignId)
    campaignContactFilters.push({ campaignId: filters.campaignId });
  if (filters.source)
    campaignContactFilters.push(campaignSpecificSourceFilter(filters.source));
  const sequenceWhere: Prisma.OutreachSequenceWhereInput = {
    ...(filters.stage ? { currentState: filters.stage } : {}),
    ...(campaignContactFilters.length
      ? { campaignContact: { AND: campaignContactFilters } }
      : {}),
    ...(filters.responseChannel
      ? { events: { some: responseEventFilter(filters.responseChannel) } }
      : {}),
  };
  const eventScope: Prisma.OutreachEventWhereInput = {
    occurredAt: { gte: day.start, lt: day.end },
    sequence: sequenceWhere,
  };
  const callbackWhere: Prisma.CallbackOutcomeWhereInput = {
    callbackAt: { gte: day.start, lt: day.end },
    ...(filters.campaignId ? { campaignId: filters.campaignId } : {}),
    ...(filters.responseChannel
      ? { attributionChannel: filters.responseChannel }
      : {}),
    ...(filters.source
      ? { campaignContact: campaignSpecificSourceFilter(filters.source) }
      : {}),
  };
  const [
    scheduled,
    processed,
    smsEligibleToday,
    smsAwaitingExport,
    coldCallEligibleToday,
    coldCallAwaitingExport,
    callbacks,
    qualifiedRows,
    externalQualifiedEvents,
    optOutEvents,
    dailyUsage,
  ] = await Promise.all([
    db.outreachSequence.count({
      where: {
        ...sequenceWhere,
        rvmScheduledFor: { gte: day.start, lt: day.end },
      },
    }),
    db.outreachSequence.count({
      where: {
        ...sequenceWhere,
        rvmAttemptedAt: { gte: day.start, lt: day.end },
      },
    }),
    db.outreachEvent.count({
      where: { ...eventScope, type: "SMS_ELIGIBLE" },
    }),
    db.outreachSequence.count({
      where: { ...sequenceWhere, currentState: "SMS_ELIGIBLE" },
    }),
    db.outreachEvent.count({
      where: { ...eventScope, type: "COLD_CALL_ELIGIBLE" },
    }),
    db.outreachSequence.count({
      where: { ...sequenceWhere, currentState: "COLD_CALL_ELIGIBLE" },
    }),
    db.callbackOutcome.findMany({
      where: {
        ...callbackWhere,
        campaignContactId: { not: null },
        attributionChannel: filters.responseChannel ?? "RVM_CALLBACK",
      },
      select: { campaignContactId: true, normalizedPhone: true },
    }),
    db.callbackOutcome.findMany({
      where: {
        ...callbackWhere,
        campaignContactId: { not: null },
        outcome: { in: ["QUALIFIED_LEAD", "CONTRACT", "CLOSED"] },
      },
      select: { campaignContactId: true, normalizedPhone: true },
    }),
    db.outreachEvent.findMany({
      where: {
        ...eventScope,
        channel: { in: ["SMS", "COLD_CALL"] },
        source: "external_outcome_import",
        type: { not: "SEQUENCE_EXITED" },
        resultingState: { in: QUALIFIED_SEQUENCE_STATES },
      },
      select: {
        sequence: { select: { campaignContactId: true } },
      },
    }),
    db.outreachEvent.findMany({
      where: { ...eventScope, resultingState: "OPT_OUT" },
      select: { sequenceId: true },
    }),
    getDailyRvmUsage(at),
  ]);
  return {
    date: day.key,
    timezone: settings.operations_timezone,
    rvmScheduled: scheduled,
    rvmProcessed: processed,
    rvmRemaining: Math.max(0, scheduled - processed),
    rvmAttempted: dailyUsage.attempted,
    rvmSuccessful: dailyUsage.successful,
    rvmAllowanceRemaining: dailyUsage.remaining,
    operatingDailyCap: dailyUsage.operatingCap,
    environmentDailyCap: dailyUsage.environmentCap,
    smsEligibleToday,
    smsAwaitingExport,
    coldCallEligibleToday,
    coldCallAwaitingExport,
    callbacks: new Set(callbacks.map(outcomeIdentity)).size,
    qualifiedLeads: new Set([
      ...qualifiedRows.flatMap((outcome) =>
        outcome.campaignContactId ? [outcome.campaignContactId] : [],
      ),
      ...externalQualifiedEvents.map(
        (event) => event.sequence.campaignContactId,
      ),
    ]).size,
    optOuts: new Set(optOutEvents.map((event) => event.sequenceId)).size,
  };
}
