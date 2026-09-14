import { Prisma, type ProviderBillingPeriod } from "@prisma/client";
import { db } from "@/lib/db";
import {
  allocateSharedCost,
  calculateCarrierCosts,
  calculateDropCowboyBilling,
} from "@/lib/costs";
import { getAppSettings, type AppSettings } from "@/lib/settings";
import { getBillingPeriodBounds, getZonedDateParts } from "@/lib/time";

const OUTREACH_PROVIDER_KEY = "OUTREACH";
const BILLING_PERIOD_LOCK_KEY = 1_934_726_051;

export interface PricingSnapshot {
  providerBillingCycleDay: number;
  dropCowboyMonthlyMinimumCents: number;
  dropCowboySuccessCostCents: number;
  carrierProviderName: string;
  carrierTrunkMonthlyCents: number;
  carrierDidMonthlyCents: number;
  carrierActiveDidCount: number;
  carrierVoiceCentsPerMinute: number;
  carrierAverageSecondsPerAttempt: number;
  infrastructureMonthlyOverheadCents: number;
}

function snapshotFromSettings(
  settings: AppSettings,
  providerBillingCycleDay = settings.provider_billing_cycle_day,
): PricingSnapshot {
  return {
    providerBillingCycleDay,
    dropCowboyMonthlyMinimumCents: settings.drop_cowboy_monthly_minimum_cents,
    dropCowboySuccessCostCents: settings.drop_cowboy_success_cost_cents,
    carrierProviderName: settings.carrier_provider_name,
    carrierTrunkMonthlyCents: settings.carrier_trunk_monthly_cents,
    carrierDidMonthlyCents: settings.carrier_did_monthly_cents,
    carrierActiveDidCount: settings.carrier_active_did_count,
    carrierVoiceCentsPerMinute: settings.carrier_voice_cents_per_minute,
    carrierAverageSecondsPerAttempt:
      settings.carrier_average_seconds_per_attempt,
    infrastructureMonthlyOverheadCents:
      settings.infrastructure_monthly_overhead_cents,
  };
}

function parseSnapshot(value: Prisma.JsonValue): PricingSnapshot {
  return value as unknown as PricingSnapshot;
}

export interface BillingBoundaryAnchor {
  startsAt: Date;
  timezone: string;
  pricingSnapshot: Prisma.JsonValue;
}

export interface BillingBoundaryPolicy {
  timezone: string;
  cycleDay: number;
}

function validCycleDay(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 28
  );
}

/**
 * Once a provider period exists, its timezone/cycle policy owns adjacent
 * periods. Editable operating settings can therefore never move historical
 * boundaries or create an overlapping month. Older snapshots predate the
 * explicit cycle-day field, so their local start day is the durable fallback.
 */
export function resolveBillingBoundaryPolicy(
  anchor: BillingBoundaryAnchor | null,
  fallback: BillingBoundaryPolicy,
): BillingBoundaryPolicy {
  if (!anchor) return fallback;
  const snapshot = parseSnapshot(anchor.pricingSnapshot);
  const storedCycleDay = snapshot.providerBillingCycleDay;
  return {
    timezone: anchor.timezone,
    cycleDay: validCycleDay(storedCycleDay)
      ? storedCycleDay
      : getZonedDateParts(anchor.startsAt, anchor.timezone).day,
  };
}

export function resolveImmutableBillingPeriodBounds(
  at: Date,
  anchor: BillingBoundaryAnchor | null,
  fallback: BillingBoundaryPolicy,
) {
  const policy = resolveBillingBoundaryPolicy(anchor, fallback);
  return {
    ...getBillingPeriodBounds(at, policy.timezone, policy.cycleDay),
    policy,
  };
}

export async function ensureOutreachBillingPeriod(
  at: Date,
): Promise<ProviderBillingPeriod> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(${BILLING_PERIOD_LOCK_KEY})::text AS locked
      `;

      const containing = await tx.providerBillingPeriod.findFirst({
        where: {
          providerKey: OUTREACH_PROVIDER_KEY,
          startsAt: { lte: at },
          endsAt: { gt: at },
        },
        orderBy: { startsAt: "desc" },
      });
      if (containing) return containing;

      const [settings, prior, next] = await Promise.all([
        getAppSettings(tx),
        tx.providerBillingPeriod.findFirst({
          where: {
            providerKey: OUTREACH_PROVIDER_KEY,
            endsAt: { lte: at },
          },
          orderBy: { endsAt: "desc" },
        }),
        tx.providerBillingPeriod.findFirst({
          where: {
            providerKey: OUTREACH_PROVIDER_KEY,
            startsAt: { gt: at },
          },
          orderBy: { startsAt: "asc" },
        }),
      ]);
      const { start, end, policy } = resolveImmutableBillingPeriodBounds(
        at,
        prior ?? next,
        {
          timezone: settings.operations_timezone,
          cycleDay: settings.provider_billing_cycle_day,
        },
      );
      const overlap = await tx.providerBillingPeriod.findFirst({
        where: {
          providerKey: OUTREACH_PROVIDER_KEY,
          startsAt: { lt: end },
          endsAt: { gt: start },
        },
      });
      if (overlap) {
        throw new Error(
          "Provider billing-period boundary conflict; existing periods require operator review",
        );
      }
      return tx.providerBillingPeriod.create({
        data: {
          providerKey: OUTREACH_PROVIDER_KEY,
          startsAt: start,
          endsAt: end,
          timezone: policy.timezone,
          pricingSnapshot: snapshotFromSettings(
            settings,
            policy.cycleDay,
          ) as unknown as Prisma.InputJsonValue,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function getBillingPeriodEconomics(period: ProviderBillingPeriod) {
  const [attempts, successes, tts, audioReuse] = await Promise.all([
    db.rvmUsageLedger.findMany({
      where: {
        kind: "ATTEMPT",
        occurredAt: { gte: period.startsAt, lt: period.endsAt },
      },
      include: {
        drop: {
          select: {
            carrierDurationSeconds: true,
            campaignContact: { select: { campaignId: true } },
          },
        },
      },
    }),
    db.rvmUsageLedger.findMany({
      where: {
        kind: "SUCCESS",
        occurredAt: { gte: period.startsAt, lt: period.endsAt },
      },
      include: {
        drop: {
          select: {
            campaignContact: { select: { campaignId: true } },
          },
        },
      },
    }),
    db.audioGenerationUsage.aggregate({
      where: {
        billingDisposition: "BILLABLE_GENERATION",
        generatedAt: { gte: period.startsAt, lt: period.endsAt },
      },
      _sum: {
        estimatedCostCents: true,
        characterCount: true,
      },
      _count: { _all: true },
    }),
    db.audioAsset.aggregate({
      where: {
        generatedAt: { gte: period.startsAt, lt: period.endsAt },
      },
      _sum: { reuseCount: true },
    }),
  ]);
  const pricing = parseSnapshot(period.pricingSnapshot);
  const attemptsByCampaign: Record<string, number> = {};
  const successesByCampaign: Record<string, number> = {};
  const secondsByCampaign: Record<string, number> = {};
  let actualDurationAttempts = 0;
  let actualDurationSeconds = 0;
  for (const attempt of attempts) {
    const campaignId = attempt.drop.campaignContact.campaignId;
    attemptsByCampaign[campaignId] = (attemptsByCampaign[campaignId] ?? 0) + 1;
    if (attempt.drop.carrierDurationSeconds != null) {
      actualDurationAttempts += 1;
      actualDurationSeconds += attempt.drop.carrierDurationSeconds;
      secondsByCampaign[campaignId] =
        (secondsByCampaign[campaignId] ?? 0) +
        attempt.drop.carrierDurationSeconds;
    } else {
      secondsByCampaign[campaignId] =
        (secondsByCampaign[campaignId] ?? 0) +
        pricing.carrierAverageSecondsPerAttempt;
    }
  }
  for (const success of successes) {
    const campaignId = success.drop.campaignContact.campaignId;
    successesByCampaign[campaignId] =
      (successesByCampaign[campaignId] ?? 0) + 1;
  }
  const dropCowboy = calculateDropCowboyBilling({
    successfulRvmCount: successes.length,
    monthlyMinimumCents: pricing.dropCowboyMonthlyMinimumCents,
    successCostCents: pricing.dropCowboySuccessCostCents,
    actualInvoiceCents: period.actualInvoiceCents,
  });
  const dropAllocation = allocateSharedCost(
    dropCowboy.invoiceCents,
    successesByCampaign,
  );
  const carrier = calculateCarrierCosts({
    attemptedRvmCount: attempts.length,
    attemptsWithActualDuration:
      period.actualCarrierSeconds == null
        ? actualDurationAttempts
        : attempts.length,
    actualDurationSeconds: period.actualCarrierSeconds ?? actualDurationSeconds,
    averageSecondsPerAttempt: pricing.carrierAverageSecondsPerAttempt,
    trunkMonthlyCents: pricing.carrierTrunkMonthlyCents,
    didMonthlyCents: pricing.carrierDidMonthlyCents,
    activeDidCount: pricing.carrierActiveDidCount,
    voiceCentsPerMinute: pricing.carrierVoiceCentsPerMinute,
  });
  const carrierFixedAllocation = allocateSharedCost(
    carrier.fixedCents,
    attemptsByCampaign,
  );
  const carrierVariableAllocation = allocateSharedCost(
    carrier.variableCents,
    period.actualCarrierSeconds == null
      ? secondsByCampaign
      : attemptsByCampaign,
  );
  const infrastructureAllocation = allocateSharedCost(
    pricing.infrastructureMonthlyOverheadCents,
    attemptsByCampaign,
  );
  const infrastructureCents = pricing.infrastructureMonthlyOverheadCents;
  const periodTotalCents =
    dropCowboy.invoiceCents +
    carrier.totalCents +
    (tts._sum.estimatedCostCents ?? 0) +
    infrastructureCents;
  return {
    period,
    pricing,
    attemptedRvmCount: attempts.length,
    successfulRvmCount: successes.length,
    successRate:
      attempts.length > 0 ? (successes.length / attempts.length) * 100 : 0,
    attemptsByCampaign,
    successesByCampaign,
    dropCowboy,
    dropAllocation,
    carrier,
    carrierFixedAllocation,
    carrierVariableAllocation,
    infrastructureAllocation,
    infrastructureCents,
    periodTotalCents,
    elevenLabsCostCents: tts._sum.estimatedCostCents ?? 0,
    elevenLabsCharacters: tts._sum.characterCount ?? 0,
    generatedAudioCount: tts._count._all,
    audioReuseCount: audioReuse._sum.reuseCount ?? 0,
  };
}

export async function getMonthlyEconomics(at = new Date()) {
  return getBillingPeriodEconomics(await ensureOutreachBillingPeriod(at));
}

export async function getAttributableOutreachCosts(campaignId?: string) {
  const [ledger, tts, audioReuse] = await Promise.all([
    db.rvmUsageLedger.findMany({
      where: campaignId
        ? { drop: { campaignContact: { campaignId } } }
        : undefined,
      select: { occurredAt: true },
      orderBy: { occurredAt: "asc" },
    }),
    db.audioGenerationUsage.aggregate({
      where: {
        billingDisposition: "BILLABLE_GENERATION",
        ...(campaignId
          ? { audioAsset: { campaignContact: { campaignId } } }
          : {}),
      },
      _sum: {
        estimatedCostCents: true,
        characterCount: true,
      },
      _count: { _all: true },
    }),
    db.audioAsset.aggregate({
      where: campaignId ? { campaignContact: { campaignId } } : undefined,
      _sum: { reuseCount: true },
    }),
  ]);
  const observedPeriods = new Map<string, ProviderBillingPeriod>();
  for (const entry of ledger) {
    const period = await ensureOutreachBillingPeriod(entry.occurredAt);
    observedPeriods.set(period.id, period);
  }
  let attempted = 0;
  let successful = 0;
  let marginalDropCowboyCents = 0;
  let allocatedDropCowboyCents = 0;
  let carrierFixedCents = 0;
  let carrierVariableCents = 0;
  let infrastructureCents = 0;
  for (const period of observedPeriods.values()) {
    const economics = await getBillingPeriodEconomics(period);
    if (campaignId) {
      const campaignAttempts = economics.attemptsByCampaign[campaignId] ?? 0;
      const campaignSuccesses = economics.successesByCampaign[campaignId] ?? 0;
      attempted += campaignAttempts;
      successful += campaignSuccesses;
      marginalDropCowboyCents += Math.round(
        campaignSuccesses * economics.pricing.dropCowboySuccessCostCents,
      );
      allocatedDropCowboyCents +=
        economics.dropAllocation.allocations[campaignId] ?? 0;
      carrierFixedCents +=
        economics.carrierFixedAllocation.allocations[campaignId] ?? 0;
      carrierVariableCents +=
        economics.carrierVariableAllocation.allocations[campaignId] ?? 0;
      infrastructureCents +=
        economics.infrastructureAllocation.allocations[campaignId] ?? 0;
    } else {
      attempted += economics.attemptedRvmCount;
      successful += economics.successfulRvmCount;
      marginalDropCowboyCents += economics.dropCowboy.usageValueCents;
      allocatedDropCowboyCents +=
        economics.dropCowboy.invoiceCents -
        economics.dropAllocation.unallocatedCents;
      carrierFixedCents +=
        economics.carrier.fixedCents -
        economics.carrierFixedAllocation.unallocatedCents;
      carrierVariableCents +=
        economics.carrier.variableCents -
        economics.carrierVariableAllocation.unallocatedCents;
      infrastructureCents +=
        economics.pricing.infrastructureMonthlyOverheadCents -
        economics.infrastructureAllocation.unallocatedCents;
    }
  }
  const elevenLabsCents = tts._sum.estimatedCostCents ?? 0;
  const totalAttributableCents =
    elevenLabsCents +
    allocatedDropCowboyCents +
    carrierFixedCents +
    carrierVariableCents +
    infrastructureCents;
  return {
    attempted,
    successful,
    rvmSuccessRate: attempted > 0 ? (successful / attempted) * 100 : 0,
    elevenLabsCents,
    elevenLabsCharacters: tts._sum.characterCount ?? 0,
    generatedAudioCount: tts._count._all,
    audioReuseCount: audioReuse._sum.reuseCount ?? 0,
    marginalDropCowboyCents,
    allocatedDropCowboyCents,
    carrierFixedCents,
    carrierVariableCents,
    carrierTotalCents: carrierFixedCents + carrierVariableCents,
    infrastructureCents,
    totalAttributableCents,
  };
}
