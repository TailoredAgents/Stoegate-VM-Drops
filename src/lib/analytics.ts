import {
  type CampaignContactStatus,
  type CampaignStatus,
  type OutreachSequenceState,
  Prisma,
  type SmsInboundClassification,
  type SmsMessageStatus,
} from "@prisma/client";
import { calculateVABenchmarks } from "@/lib/costs";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getAppSettings } from "@/lib/settings";
import {
  getLocalDayBounds,
  localDateStorageValue,
  zonedDateTimeToUtc,
} from "@/lib/time";
import { percent } from "@/lib/utils";

export type AnalyticsAttributionChannel = "SMS" | "COLD_CALL" | "OTHER";
export type AnalyticsLeadFilter = boolean | "with_lead" | "without_lead";
export type AnalyticsExportFilter =
  boolean | "eligible" | "exported" | "not_exported";

export interface AnalyticsFilters {
  campaignId?: string;
  campaignStatus?: CampaignStatus;
  contactStatus?: CampaignContactStatus;
  date?: string;
  source?: string;
  state?: string;
  county?: string;
  status?: SmsMessageStatus;
  classification?: SmsInboundClassification;
  lead?: AnalyticsLeadFilter;
  export?: AnalyticsExportFilter;
  stage?: OutreachSequenceState;
  creditedChannel?: AnalyticsAttributionChannel;
}

export interface AnalyticsDateRange {
  start: Date;
  end: Date;
  key: string;
  storageDate: Date;
}

export interface ChannelAttributionSummary {
  sms: number;
  coldCall: number;
  other: number;
}

export interface SmsEconomicsInput {
  attempted: number;
  accepted: number;
  sent: number;
  delivered: number;
  replies: number;
  interested: number;
  qualified: number;
  nonresponders: number;
  batchDialerEligible: number;
  batchDialerExported: number;
  coldCallQualifiedLeads: number;
  contracts: number;
  closed: number;
  outboundSegments: number;
  inboundMessages: number;
  configuredOutboundMessageCostMicros: number;
  configuredSegmentCostMicros: number;
  configuredInboundMessageCostMicros: number;
  configuredFixedMonthlyCents: number;
  estimatedOutboundCostMicros: number;
  providerActualCostMicros: number;
  estimatedFallbackCostMicros: number;
  messagesWithActualCost: number;
}

const SENT_OR_LATER_STATUSES: SmsMessageStatus[] = [
  "SENT",
  "DELIVERED",
  "UNDELIVERED",
  "REPLIED",
];
const INTERESTED_CLASSIFICATIONS: SmsInboundClassification[] = [
  "INTERESTED",
  "MAYBE",
  "FOLLOW_UP",
  "QUALIFIED_LEAD",
];
const QUEUED_STATUSES: SmsMessageStatus[] = [
  "PENDING",
  "SCHEDULED",
  "QUEUED",
  "SUBMITTING",
];
const CONTRACT_STATES: OutreachSequenceState[] = ["CONTRACT", "CLOSED"];
export const QUALIFIED_LEAD_OUTCOMES = ["QUALIFIED_LEAD", "CONTRACT", "CLOSED"];

function nonNegative(value: number | null | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function wholeCount(value: number | null | undefined): number {
  return Math.trunc(nonNegative(value));
}

export function effectiveGlobalDailySmsCap(
  configuredCap: number,
  environmentCap: number,
): number {
  return Math.min(wholeCount(configuredCap), wholeCount(environmentCap));
}

export function areSmsCostCurrenciesComparable(currencies: string[]) {
  const normalized = new Set(
    currencies.map((currency) => currency.trim().toUpperCase()),
  );
  return (
    normalized.size === 0 || (normalized.size === 1 && normalized.has("USD"))
  );
}

export function isQualifiedLeadOutcome(
  outcome: string | null | undefined,
): boolean {
  return Boolean(outcome && QUALIFIED_LEAD_OUTCOMES.includes(outcome));
}

export function qualifiedLeadCampaignContactWhere(
  hasQualifiedLead: boolean,
): Prisma.CampaignContactWhereInput {
  const qualifyingOutcome = { in: QUALIFIED_LEAD_OUTCOMES };
  if (hasQualifiedLead) {
    return { leadAttribution: { is: { qualifyingOutcome } } };
  }
  return {
    OR: [
      { leadAttribution: { is: null } },
      {
        leadAttribution: {
          is: { qualifyingOutcome: { notIn: QUALIFIED_LEAD_OUTCOMES } },
        },
      },
    ],
  };
}

export function buildSmsCampaignInboundWhere(
  extra: Prisma.SmsInboundMessageWhereInput = {},
): Prisma.SmsInboundMessageWhereInput {
  return {
    AND: [
      {
        campaignContact: {
          is: { campaign: { is: { kind: "SMS" } } },
        },
      },
      extra,
    ],
  };
}

function perUnit(totalCents: number, count: number): number | null {
  return count > 0 ? totalCents / count : null;
}

function normalizeFilters(input?: string | AnalyticsFilters): AnalyticsFilters {
  if (typeof input === "string") return { campaignId: input };
  return input ?? {};
}

/**
 * Convert an operator-selected local calendar day into an exact UTC range.
 * The midday reference keeps this correct across daylight-saving transitions.
 */
export function analyticsDateRange(
  date: string,
  timeZone: string,
): AnalyticsDateRange {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("Analytics date must use YYYY-MM-DD");
  const [year, month, day] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!year || month < 1 || month > 12 || day < 1 || day > lastDay)
    throw new Error("Analytics date is invalid");
  const reference = zonedDateTimeToUtc(
    { year, month, day, hour: 12, minute: 0 },
    timeZone,
  );
  const range = getLocalDayBounds(reference, timeZone);
  return {
    ...range,
    storageDate: localDateStorageValue(reference, timeZone),
  };
}

function optionalDateRange(
  date: string | undefined,
  timeZone: string,
): AnalyticsDateRange | undefined {
  return date ? analyticsDateRange(date, timeZone) : undefined;
}

/** Build the reusable campaign-contact cohort without fetching any records. */
export function buildAnalyticsCampaignContactWhere(
  filters: AnalyticsFilters = {},
): Prisma.CampaignContactWhereInput {
  const clauses: Prisma.CampaignContactWhereInput[] = [
    {
      campaign: {
        is: {
          kind: "SMS",
          ...(filters.campaignStatus ? { status: filters.campaignStatus } : {}),
        },
      },
    },
  ];

  if (filters.campaignId) clauses.push({ campaignId: filters.campaignId });
  if (filters.contactStatus) clauses.push({ status: filters.contactStatus });

  const source = filters.source?.trim();
  if (source) {
    const textMatch = { contains: source, mode: "insensitive" as const };
    clauses.push({
      OR: [
        { campaign: { is: { sourceName: textMatch } } },
        {
          importRow: {
            is: {
              mappedData: {
                path: ["source"],
                string_contains: source,
                mode: "insensitive",
              },
            },
          },
        },
        { property: { is: { source: textMatch } } },
        { contact: { is: { source: textMatch } } },
      ],
    });
  }

  const state = filters.state?.trim();
  if (state) {
    clauses.push({
      property: {
        is: {
          state: { equals: state.toUpperCase(), mode: "insensitive" },
        },
      },
    });
  }

  const county = filters.county?.trim();
  if (county) {
    clauses.push({
      property: {
        is: { county: { contains: county, mode: "insensitive" } },
      },
    });
  }

  if (filters.status) {
    clauses.push({ outboundMessages: { some: { status: filters.status } } });
  }
  if (filters.classification) {
    clauses.push({
      inboundMessages: { some: { classification: filters.classification } },
    });
  }

  if (filters.lead === true || filters.lead === "with_lead") {
    clauses.push(qualifiedLeadCampaignContactWhere(true));
  } else if (filters.lead === false || filters.lead === "without_lead") {
    clauses.push(qualifiedLeadCampaignContactWhere(false));
  }
  if (filters.creditedChannel) {
    clauses.push({
      leadAttribution: { is: { creditedChannel: filters.creditedChannel } },
    });
  }

  const sequenceClauses: Prisma.OutreachSequenceWhereInput[] = [];
  if (filters.stage) sequenceClauses.push({ currentState: filters.stage });
  if (filters.export === true || filters.export === "exported") {
    sequenceClauses.push({
      exportClaims: { some: { type: "BATCH_DIALER" } },
    });
  } else if (filters.export === false || filters.export === "not_exported") {
    sequenceClauses.push({
      exportClaims: { none: { type: "BATCH_DIALER" } },
    });
  } else if (filters.export === "eligible") {
    sequenceClauses.push(
      { currentState: "COLD_CALL_ELIGIBLE" },
      { exportClaims: { none: { type: "BATCH_DIALER" } } },
    );
  }
  if (sequenceClauses.length > 0) {
    clauses.push({ outreachSequence: { is: { AND: sequenceClauses } } });
  }

  return { AND: clauses };
}

export function summarizeChannelAttribution(
  rows: ReadonlyArray<{
    creditedChannel: string;
    _count: { _all: number };
  }>,
): ChannelAttributionSummary {
  const result: ChannelAttributionSummary = {
    sms: 0,
    coldCall: 0,
    other: 0,
  };
  for (const row of rows) {
    const count = wholeCount(row._count._all);
    if (row.creditedChannel === "SMS") result.sms += count;
    else if (row.creditedChannel === "COLD_CALL") result.coldCall += count;
    else result.other += count;
  }
  return result;
}

/**
 * Mix provider-reported costs with per-message estimates only where an actual
 * cost is absent. This avoids both discarding estimates and double-counting.
 */
export function summarizeSmsEconomics(input: SmsEconomicsInput) {
  const attempted = wholeCount(input.attempted);
  const segments = wholeCount(input.outboundSegments);
  const inbound = wholeCount(input.inboundMessages);
  const actualCostMessages = Math.min(
    attempted,
    wholeCount(input.messagesWithActualCost),
  );
  const configuredOutboundCostMicros =
    attempted * nonNegative(input.configuredOutboundMessageCostMicros) +
    segments * nonNegative(input.configuredSegmentCostMicros);
  const configuredInboundCostMicros =
    inbound * nonNegative(input.configuredInboundMessageCostMicros);
  const configuredVariableCostMicros =
    configuredOutboundCostMicros + configuredInboundCostMicros;
  const estimatedSnapshotCostMicros =
    nonNegative(input.estimatedOutboundCostMicros) +
    configuredInboundCostMicros;
  const providerActualCostMicros = nonNegative(input.providerActualCostMicros);
  const estimatedFallbackCostMicros = nonNegative(
    input.estimatedFallbackCostMicros,
  );
  const effectiveVariableCostMicros =
    providerActualCostMicros +
    estimatedFallbackCostMicros +
    configuredInboundCostMicros;
  const configuredFixedMonthlyCents = nonNegative(
    input.configuredFixedMonthlyCents,
  );
  const variableCostCents = effectiveVariableCostMicros / 10_000;
  // Fixed fees are a monthly run-rate, not attributable to an arbitrary
  // campaign/date slice without an allocation policy.
  const totalCostCents = variableCostCents;
  const allInMonthlyRunRateCents =
    configuredFixedMonthlyCents + variableCostCents;

  return {
    configuredOutboundCostMicros,
    configuredInboundCostMicros,
    configuredVariableCostMicros,
    estimatedSnapshotCostMicros,
    providerActualCostMicros,
    estimatedFallbackCostMicros,
    effectiveVariableCostMicros,
    configuredVariableCostCents: configuredVariableCostMicros / 10_000,
    estimatedSnapshotCostCents: estimatedSnapshotCostMicros / 10_000,
    providerActualCostCents: providerActualCostMicros / 10_000,
    estimatedFallbackCostCents: estimatedFallbackCostMicros / 10_000,
    effectiveVariableCostCents: variableCostCents,
    configuredFixedMonthlyCents,
    variableCostCents,
    totalCostCents,
    allInMonthlyRunRateCents,
    messagesWithActualCost: actualCostMessages,
    messagesUsingEstimatedCost: Math.max(0, attempted - actualCostMessages),
    providerActualCoverageRate: percent(actualCostMessages, attempted),
    costPerAttemptCents: perUnit(totalCostCents, attempted),
    costPerAcceptedCents: perUnit(totalCostCents, wholeCount(input.accepted)),
    costPerSentCents: perUnit(totalCostCents, wholeCount(input.sent)),
    costPerDeliveredCents: perUnit(totalCostCents, wholeCount(input.delivered)),
    costPerReplyCents: perUnit(totalCostCents, wholeCount(input.replies)),
    costPerInterestedCents: perUnit(
      totalCostCents,
      wholeCount(input.interested),
    ),
    costPerQualifiedLeadCents: perUnit(
      totalCostCents,
      wholeCount(input.qualified),
    ),
    costPerNonresponderCents: perUnit(
      totalCostCents,
      wholeCount(input.nonresponders),
    ),
    costPerBatchDialerEligibleCents: perUnit(
      totalCostCents,
      wholeCount(input.batchDialerEligible),
    ),
    costPerBatchDialerExportedCents: perUnit(
      totalCostCents,
      wholeCount(input.batchDialerExported),
    ),
    costPerColdCallLeadCents: perUnit(
      totalCostCents,
      wholeCount(input.coldCallQualifiedLeads),
    ),
    costPerContractCents: perUnit(totalCostCents, wholeCount(input.contracts)),
    costPerClosedDealCents: perUnit(totalCostCents, wholeCount(input.closed)),
  };
}

function omitIncomparableProviderEconomics(
  economics: ReturnType<typeof summarizeSmsEconomics>,
) {
  return {
    ...economics,
    providerActualCostMicros: null,
    estimatedFallbackCostMicros: null,
    effectiveVariableCostMicros: null,
    providerActualCostCents: null,
    estimatedFallbackCostCents: null,
    effectiveVariableCostCents: null,
    variableCostCents: null,
    totalCostCents: null,
    allInMonthlyRunRateCents: null,
    costPerAttemptCents: null,
    costPerAcceptedCents: null,
    costPerSentCents: null,
    costPerDeliveredCents: null,
    costPerReplyCents: null,
    costPerInterestedCents: null,
    costPerQualifiedLeadCents: null,
    costPerNonresponderCents: null,
    costPerBatchDialerEligibleCents: null,
    costPerBatchDialerExportedCents: null,
    costPerColdCallLeadCents: null,
    costPerContractCents: null,
    costPerClosedDealCents: null,
  };
}

/** Accepted is intentionally absent: provider acceptance does not prove send. */
export function buildSentMessageLifecycleWhere(
  range?: Pick<AnalyticsDateRange, "start" | "end">,
): Prisma.SmsOutboundMessageWhereInput {
  if (range) return { sentAt: { gte: range.start, lt: range.end } };
  return {
    OR: [{ sentAt: { not: null } }, { status: { in: SENT_OR_LATER_STATUSES } }],
  };
}

function messageStatusClause(
  status: SmsMessageStatus | undefined,
): Prisma.SmsOutboundMessageWhereInput | undefined {
  return status ? { status } : undefined;
}

function outboundMessageWhere(
  cohort: Prisma.CampaignContactWhereInput,
  filters: AnalyticsFilters,
  extra?: Prisma.SmsOutboundMessageWhereInput,
): Prisma.SmsOutboundMessageWhereInput {
  return {
    AND: [
      { campaignContact: { is: cohort } },
      ...(messageStatusClause(filters.status)
        ? [messageStatusClause(filters.status)!]
        : []),
      ...(extra ? [extra] : []),
    ],
  };
}

function inboundMessageWhere(
  cohort: Prisma.CampaignContactWhereInput,
  filters: AnalyticsFilters,
  range: AnalyticsDateRange | undefined,
  extra?: Prisma.SmsInboundMessageWhereInput,
): Prisma.SmsInboundMessageWhereInput {
  return {
    AND: [
      { campaignContact: { is: cohort } },
      ...(filters.classification
        ? [{ classification: filters.classification }]
        : []),
      ...(range ? [{ receivedAt: { gte: range.start, lt: range.end } }] : []),
      ...(extra ? [extra] : []),
    ],
  };
}

function eventWhere(
  range: AnalyticsDateRange | undefined,
  extra: Prisma.OutreachEventWhereInput,
): Prisma.OutreachEventWhereInput {
  return {
    AND: [
      extra,
      ...(range ? [{ occurredAt: { gte: range.start, lt: range.end } }] : []),
    ],
  };
}

function rangeFor(
  range: AnalyticsDateRange | undefined,
): Prisma.DateTimeFilter | undefined {
  return range ? { gte: range.start, lt: range.end } : undefined;
}

export async function getCampaignMetrics(input?: string | AnalyticsFilters) {
  const filters = normalizeFilters(input);
  const settings = await getAppSettings();
  const range = optionalDateRange(filters.date, settings.operations_timezone);
  const dateFilter = rangeFor(range);
  const cohort = buildAnalyticsCampaignContactWhere(filters);
  const campaignWhere: Prisma.CampaignWhereInput = {
    kind: "SMS",
    ...(filters.campaignId ? { id: filters.campaignId } : {}),
    ...(filters.campaignStatus ? { status: filters.campaignStatus } : {}),
  };
  const attemptedMessageWhere = outboundMessageWhere(cohort, filters, {
    usageLedger: {
      some: {
        kind: "ATTEMPT",
        ...(dateFilter ? { occurredAt: dateFilter } : {}),
      },
    },
  });
  const attemptLedgerWhere: Prisma.SmsUsageLedgerWhereInput = {
    kind: "ATTEMPT",
    ...(dateFilter ? { occurredAt: dateFilter } : {}),
    message: {
      is: outboundMessageWhere(cohort, filters),
    },
  };
  const acceptedLedgerWhere: Prisma.SmsUsageLedgerWhereInput = {
    kind: "ACCEPTED",
    ...(dateFilter ? { occurredAt: dateFilter } : {}),
    message: {
      is: outboundMessageWhere(cohort, filters),
    },
  };
  const deliveredLedgerWhere: Prisma.SmsUsageLedgerWhereInput = {
    kind: "DELIVERED",
    ...(dateFilter ? { occurredAt: dateFilter } : {}),
    message: {
      is: outboundMessageWhere(cohort, filters),
    },
  };
  const replySome = inboundMessageWhere(cohort, filters, range);
  const leadWhere: Prisma.LeadAttributionWhereInput = {
    campaignContact: { is: cohort },
    campaign: { is: { kind: "SMS" } },
    ...(filters.creditedChannel
      ? { creditedChannel: filters.creditedChannel }
      : {}),
    ...(dateFilter ? { attributedAt: dateFilter } : {}),
    qualifyingOutcome: { in: QUALIFIED_LEAD_OUTCOMES },
  };
  const sequenceScope: Prisma.OutreachSequenceWhereInput = {
    campaignContact: { is: cohort },
  };
  const sentCondition = buildSentMessageLifecycleWhere(range);
  const coldCallContactEvent = eventWhere(range, {
    channel: "COLD_CALL",
    OR: [
      { type: "COLD_CALL_CONTACTED" },
      {
        type: "OUTCOME_RECORDED",
        resultingState: {
          in: [
            "INTERESTED",
            "QUALIFIED_LEAD",
            "FOLLOW_UP",
            "NOT_INTERESTED",
            "WRONG_NUMBER",
            "OPT_OUT",
            "CONTRACT",
            "CLOSED",
          ],
        },
      },
    ],
  });
  const contractEvent = (channel?: "SMS" | "COLD_CALL") =>
    eventWhere(range, {
      ...(channel ? { channel } : { channel: { in: ["SMS", "COLD_CALL"] } }),
      type: { not: "SEQUENCE_EXITED" },
      resultingState: { in: CONTRACT_STATES },
    });
  const closedEvent = (channel?: "SMS" | "COLD_CALL") =>
    eventWhere(range, {
      ...(channel ? { channel } : { channel: { in: ["SMS", "COLD_CALL"] } }),
      type: { not: "SEQUENCE_EXITED" },
      resultingState: "CLOSED",
    });

  const [
    campaignTotals,
    contactStatusGroups,
    selected,
    queued,
    dryRun,
    attempted,
    accepted,
    sent,
    delivered,
    failed,
    undelivered,
    inboundMessages,
    replies,
    optOuts,
    interested,
    attributionGroups,
    nonresponders,
    batchDialerEligible,
    batchDialerExported,
    coldCallContacted,
    contracts,
    closed,
    smsContracts,
    smsClosed,
    coldCallContracts,
    coldCallClosed,
    costAggregate,
    fallbackCostAggregate,
    currencyGroups,
  ] = await Promise.all([
    db.campaign.aggregate({
      where: campaignWhere,
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
      where: cohort,
      _count: { _all: true },
    }),
    db.campaignContact.count({
      where: { AND: [cohort, { selectedForSend: true }] },
    }),
    db.smsOutboundMessage.count({
      where: outboundMessageWhere(cohort, filters, {
        status: { in: QUEUED_STATUSES },
        ...(dateFilter ? { scheduledFor: dateFilter } : {}),
      }),
    }),
    db.smsOutboundMessage.count({
      where: outboundMessageWhere(cohort, filters, {
        status: "DRY_RUN",
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      }),
    }),
    db.smsUsageLedger.count({ where: attemptLedgerWhere }),
    db.smsUsageLedger.count({ where: acceptedLedgerWhere }),
    db.smsOutboundMessage.count({
      where: outboundMessageWhere(cohort, filters, sentCondition),
    }),
    db.smsUsageLedger.count({ where: deliveredLedgerWhere }),
    db.smsOutboundMessage.count({
      where: outboundMessageWhere(cohort, filters, {
        status: "FAILED",
        ...(dateFilter ? { failedAt: dateFilter } : {}),
      }),
    }),
    db.smsOutboundMessage.count({
      where: outboundMessageWhere(cohort, filters, {
        status: "UNDELIVERED",
        ...(dateFilter ? { failedAt: dateFilter } : {}),
      }),
    }),
    db.smsInboundMessage.count({ where: replySome }),
    db.campaignContact.count({
      where: {
        AND: [
          cohort,
          {
            inboundMessages: {
              some: {
                ...(filters.classification
                  ? { classification: filters.classification }
                  : {}),
                ...(dateFilter ? { receivedAt: dateFilter } : {}),
              },
            },
          },
        ],
      },
    }),
    db.campaignContact.count({
      where: {
        AND: [
          cohort,
          {
            inboundMessages: {
              some: {
                isOptOut: true,
                ...(filters.classification
                  ? { classification: filters.classification }
                  : {}),
                ...(dateFilter ? { receivedAt: dateFilter } : {}),
              },
            },
          },
        ],
      },
    }),
    db.campaignContact.count({
      where: {
        AND: [
          cohort,
          {
            inboundMessages: {
              some: {
                classification: { in: INTERESTED_CLASSIFICATIONS },
                ...(filters.classification
                  ? { AND: [{ classification: filters.classification }] }
                  : {}),
                ...(dateFilter ? { receivedAt: dateFilter } : {}),
              },
            },
          },
        ],
      },
    }),
    db.leadAttribution.groupBy({
      by: ["creditedChannel"],
      where: leadWhere,
      _count: { _all: true },
    }),
    db.campaignContact.count({
      where: {
        AND: [
          cohort,
          {
            outboundMessages: {
              some: {
                ...sentCondition,
                ...(filters.status ? { status: filters.status } : {}),
              },
            },
            inboundMessages: { none: {} },
            leadAttribution: { is: null },
          },
        ],
      },
    }),
    db.outreachSequence.count({
      where: {
        AND: [
          sequenceScope,
          {
            currentState: "COLD_CALL_ELIGIBLE",
            exportClaims: { none: { type: "BATCH_DIALER" } },
            ...(dateFilter ? { coldCallEligibleAt: dateFilter } : {}),
          },
        ],
      },
    }),
    db.outreachSequence.count({
      where: {
        AND: [
          sequenceScope,
          {
            exportClaims: {
              some: {
                type: "BATCH_DIALER",
                ...(dateFilter ? { claimedAt: dateFilter } : {}),
              },
            },
          },
        ],
      },
    }),
    db.outreachSequence.count({
      where: {
        AND: [sequenceScope, { events: { some: coldCallContactEvent } }],
      },
    }),
    db.outreachSequence.count({
      where: { AND: [sequenceScope, { events: { some: contractEvent() } }] },
    }),
    db.outreachSequence.count({
      where: { AND: [sequenceScope, { events: { some: closedEvent() } }] },
    }),
    db.outreachSequence.count({
      where: {
        AND: [sequenceScope, { events: { some: contractEvent("SMS") } }],
      },
    }),
    db.outreachSequence.count({
      where: { AND: [sequenceScope, { events: { some: closedEvent("SMS") } }] },
    }),
    db.outreachSequence.count({
      where: {
        AND: [sequenceScope, { events: { some: contractEvent("COLD_CALL") } }],
      },
    }),
    db.outreachSequence.count({
      where: {
        AND: [sequenceScope, { events: { some: closedEvent("COLD_CALL") } }],
      },
    }),
    db.smsOutboundMessage.aggregate({
      where: attemptedMessageWhere,
      _sum: {
        segmentCount: true,
        actualSegmentCount: true,
        estimatedCostMicros: true,
        actualCostMicros: true,
      },
      _count: { _all: true, actualCostMicros: true },
    }),
    db.smsOutboundMessage.aggregate({
      where: {
        AND: [attemptedMessageWhere, { actualCostMicros: null }],
      },
      _sum: { estimatedCostMicros: true },
    }),
    db.smsOutboundMessage.groupBy({
      by: ["currency"],
      where: attemptedMessageWhere,
      _count: { _all: true },
    }),
  ]);

  const channelAttribution = summarizeChannelAttribution(attributionGroups);
  const qualified =
    channelAttribution.sms +
    channelAttribution.coldCall +
    channelAttribution.other;
  const coldCallQualifiedLeads = channelAttribution.coldCall;
  const unsuccessful = failed + undelivered;
  const configuredFixedMonthlyCents =
    settings.sms_provider_fixed_monthly_fee_cents +
    settings.sms_phone_number_monthly_cents +
    settings.sms_registration_monthly_cents +
    settings.infrastructure_monthly_overhead_cents;
  const economics = summarizeSmsEconomics({
    attempted,
    accepted,
    sent,
    delivered,
    replies,
    interested,
    qualified,
    nonresponders,
    batchDialerEligible,
    batchDialerExported,
    coldCallQualifiedLeads,
    contracts,
    closed,
    outboundSegments: costAggregate._sum.segmentCount ?? 0,
    inboundMessages,
    configuredOutboundMessageCostMicros:
      settings.sms_cost_per_outbound_message_micros,
    configuredSegmentCostMicros:
      settings.sms_cost_per_segment_micros +
      settings.sms_carrier_surcharge_per_outbound_segment_micros,
    configuredInboundMessageCostMicros:
      settings.sms_cost_per_inbound_message_micros,
    configuredFixedMonthlyCents,
    estimatedOutboundCostMicros: costAggregate._sum.estimatedCostMicros ?? 0,
    providerActualCostMicros: costAggregate._sum.actualCostMicros ?? 0,
    estimatedFallbackCostMicros:
      fallbackCostAggregate._sum.estimatedCostMicros ?? 0,
    messagesWithActualCost: costAggregate._count.actualCostMicros,
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
  const expectedDeals = qualified / settings.va_leads_per_deal;
  const currency =
    currencyGroups.length === 0
      ? "USD"
      : currencyGroups.length === 1
        ? currencyGroups[0].currency
        : "MIXED";
  const hasMixedCurrencies = currencyGroups.length > 1;
  // Configuration and VA benchmarks are denominated in USD. Never add or
  // compare provider amounts in another (or multiple) currency without an
  // explicit FX policy.
  const costsComparable = areSmsCostCurrenciesComparable(
    currencyGroups.map((group) => group.currency),
  );
  const reportableEconomics = costsComparable
    ? economics
    : omitIncomparableProviderEconomics(economics);

  return {
    date: range?.key ?? null,
    timezone: settings.operations_timezone,
    uploaded: campaignTotals._sum.uploadedCount ?? 0,
    eligible: campaignTotals._sum.eligibleCount ?? 0,
    suppressed: campaignTotals._sum.suppressedCount ?? 0,
    invalid: campaignTotals._sum.invalidCount ?? 0,
    duplicate: campaignTotals._sum.duplicateCount ?? 0,
    selected,
    queued,
    dryRun,
    attempted,
    accepted,
    sent,
    delivered,
    failed,
    undelivered,
    unsuccessful,
    acceptanceRate: percent(accepted, attempted),
    sendRate: percent(sent, attempted),
    acceptedToSentRate: percent(sent, accepted),
    deliveryRate: percent(delivered, sent),
    failureRate: percent(unsuccessful, attempted),
    inboundMessages,
    replies,
    replyRate: percent(replies, sent),
    optOuts,
    optOutRate: percent(optOuts, sent),
    interested,
    interestedRate: percent(interested, replies),
    qualified,
    qualificationRate: percent(channelAttribution.sms, interested),
    rateBasis: range ? "EVENT_ACTIVITY" : "ALL_TIME_LIFECYCLE",
    nonresponders,
    nonresponseRate: percent(nonresponders, sent),
    batchDialerEligible,
    batchDialerExported,
    batchDialerExportRate: percent(
      batchDialerExported,
      batchDialerEligible + batchDialerExported,
    ),
    coldCallContacted,
    coldCallQualifiedLeads,
    coldCallContracts,
    coldCallClosed,
    contracts,
    closed,
    smsContracts,
    smsClosed,
    channelAttribution,
    outboundSegments: costAggregate._sum.segmentCount ?? 0,
    providerReportedSegments: costAggregate._sum.actualSegmentCount ?? 0,
    currency,
    hasMixedCurrencies,
    costsComparable,
    ...reportableEconomics,
    ...va,
    expectedDeals,
    costPerExpectedDealCents:
      costsComparable && expectedDeals > 0
        ? economics.totalCostCents / expectedDeals
        : null,
    smsSavingsVsVaPerQualifiedLeadCents:
      !costsComparable || economics.costPerQualifiedLeadCents == null
        ? null
        : va.vaCostPerQualifiedLeadCents - economics.costPerQualifiedLeadCents,
    contactStatusCounts: Object.fromEntries(
      contactStatusGroups.map((row) => [row.status, row._count._all]),
    ) as Partial<Record<CampaignContactStatus, number>>,
  };
}

export async function getOutreachFunnel(input?: string | AnalyticsFilters) {
  const filters = normalizeFilters(input);
  const settings = await getAppSettings();
  const range = optionalDateRange(filters.date, settings.operations_timezone);
  const cohort = buildAnalyticsCampaignContactWhere(filters);
  const [metrics, stateGroups] = await Promise.all([
    getCampaignMetrics(filters),
    db.outreachSequence.groupBy({
      by: ["currentState"],
      where: {
        campaignContact: { is: cohort },
        ...(range ? { lastEventAt: { gte: range.start, lt: range.end } } : {}),
      },
      _count: { _all: true },
    }),
  ]);

  return {
    sms: {
      queued: metrics.queued,
      dryRun: metrics.dryRun,
      attempted: metrics.attempted,
      accepted: metrics.accepted,
      sent: metrics.sent,
      delivered: metrics.delivered,
      failed: metrics.failed,
      undelivered: metrics.undelivered,
      replies: metrics.replies,
      optOuts: metrics.optOuts,
      interested: metrics.interested,
      qualifiedLeads: metrics.channelAttribution.sms,
      nonresponders: metrics.nonresponders,
      contracts: metrics.smsContracts,
      closed: metrics.smsClosed,
    },
    batchDialer: {
      eligible: metrics.batchDialerEligible,
      exported: metrics.batchDialerExported,
      exportRate: metrics.batchDialerExportRate,
    },
    coldCall: {
      contacted: metrics.coldCallContacted,
      qualifiedLeads: metrics.coldCallQualifiedLeads,
      contracts: metrics.coldCallContracts,
      closed: metrics.coldCallClosed,
    },
    channelAttribution: metrics.channelAttribution,
    stateCounts: Object.fromEntries(
      stateGroups.map((row) => [row.currentState, row._count._all]),
    ) as Partial<Record<OutreachSequenceState, number>>,
  };
}

export interface TodayOperationsFilters extends AnalyticsFilters {
  /** Compatibility name for the existing outreach filter UI. */
  responseChannel?: AnalyticsAttributionChannel;
}

export async function getTodayOperations(filters: TodayOperationsFilters = {}) {
  const settings = await getAppSettings();
  const env = getEnv();
  const referenceInstant = new Date();
  const today = filters.date
    ? analyticsDateRange(filters.date, settings.operations_timezone)
    : (() => {
        const range = getLocalDayBounds(
          referenceInstant,
          settings.operations_timezone,
        );
        return {
          ...range,
          storageDate: localDateStorageValue(
            referenceInstant,
            settings.operations_timezone,
          ),
        };
      })();
  const campaignPolicyGroups = filters.campaignId
    ? await db.campaign.groupBy({
        by: ["smsScheduleTimezone", "smsDailyCap"],
        where: { id: filters.campaignId, kind: "SMS" },
        _count: { _all: true },
      })
    : [];
  const campaignPolicy = campaignPolicyGroups[0];
  const campaignReference = filters.date
    ? new Date((today.start.getTime() + today.end.getTime()) / 2)
    : referenceInstant;
  const campaignDay = campaignPolicy
    ? getLocalDayBounds(campaignReference, campaignPolicy.smsScheduleTimezone)
    : undefined;
  const analyticsFilters: AnalyticsFilters = {
    ...filters,
    date: today.key,
    creditedChannel: filters.creditedChannel ?? filters.responseChannel,
  };
  const cohort = buildAnalyticsCampaignContactWhere(analyticsFilters);
  const dateFilter = { gte: today.start, lt: today.end };

  const [
    metrics,
    scheduled,
    scheduledRemaining,
    globalUsage,
    campaignAttempted,
  ] = await Promise.all([
    getCampaignMetrics(analyticsFilters),
    db.smsOutboundMessage.count({
      where: outboundMessageWhere(cohort, analyticsFilters, {
        scheduledFor: dateFilter,
      }),
    }),
    db.smsOutboundMessage.count({
      where: outboundMessageWhere(cohort, analyticsFilters, {
        scheduledFor: dateFilter,
        usageLedger: { none: { kind: "ATTEMPT" } },
      }),
    }),
    db.smsDailyUsage.aggregate({
      where: {
        localDate: today.storageDate,
        timezone: settings.operations_timezone,
      },
      _sum: {
        attemptedCount: true,
        acceptedCount: true,
        deliveredCount: true,
      },
    }),
    campaignDay && filters.campaignId
      ? db.smsUsageLedger.count({
          where: {
            kind: "ATTEMPT",
            occurredAt: { gte: campaignDay.start, lt: campaignDay.end },
            message: {
              is: {
                campaignContact: {
                  is: { campaignId: filters.campaignId },
                },
              },
            },
          },
        })
      : Promise.resolve(null),
  ]);

  const globalDailyCap = effectiveGlobalDailySmsCap(
    settings.daily_sms_cap,
    env.MAX_LIVE_DAILY_SMS_LIMIT,
  );
  const globalAttempted = globalUsage._sum.attemptedCount ?? 0;
  const campaignDailyCap = campaignPolicy?.smsDailyCap ?? null;

  return {
    date: today.key,
    timezone: settings.operations_timezone,
    smsScheduled: scheduled,
    smsProcessed: metrics.attempted,
    smsRemaining: scheduledRemaining,
    smsQueued: metrics.queued,
    smsAttempted: metrics.attempted,
    smsAccepted: metrics.accepted,
    smsSent: metrics.sent,
    smsDelivered: metrics.delivered,
    smsFailed: metrics.unsuccessful,
    replies: metrics.replies,
    optOuts: metrics.optOuts,
    interested: metrics.interested,
    qualifiedLeads: metrics.qualified,
    nonresponders: metrics.nonresponders,
    batchDialerEligible: metrics.batchDialerEligible,
    batchDialerExported: metrics.batchDialerExported,
    coldCallContacted: metrics.coldCallContacted,
    coldCallQualifiedLeads: metrics.coldCallQualifiedLeads,
    contracts: metrics.contracts,
    closed: metrics.closed,
    campaignDailyCap,
    campaignCapTimezone: campaignPolicy?.smsScheduleTimezone ?? null,
    campaignAttempted,
    campaignAllowanceRemaining:
      campaignDailyCap == null || campaignAttempted == null
        ? null
        : Math.max(0, campaignDailyCap - campaignAttempted),
    configuredDailyCap: settings.daily_sms_cap,
    environmentDailyCap: env.MAX_LIVE_DAILY_SMS_LIMIT,
    liveSendsEnabled: env.SMS_LIVE_SENDS_ENABLED,
    globalDailyCap,
    globalAttempted,
    globalAccepted: globalUsage._sum.acceptedCount ?? 0,
    globalDelivered: globalUsage._sum.deliveredCount ?? 0,
    globalAllowanceRemaining: Math.max(0, globalDailyCap - globalAttempted),
  };
}
