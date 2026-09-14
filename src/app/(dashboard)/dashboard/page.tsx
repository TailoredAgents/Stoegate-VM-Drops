import Link from "next/link";
import {
  ArrowRight,
  BadgeDollarSign,
  Megaphone,
  PhoneCall,
  Target,
  Voicemail,
  MessageSquareText,
  Clock3,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import {
  getCampaignMetrics,
  getOutreachFunnel,
  getTodayOperations,
} from "@/lib/analytics";
import { getMonthlyEconomics } from "@/lib/billing-economics";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/utils";

export default async function DashboardPage() {
  const [metrics, campaigns, today, funnel, monthly] = await Promise.all([
    getCampaignMetrics(),
    db.campaign.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      include: { _count: { select: { contacts: true } } },
    }),
    getTodayOperations(),
    getOutreachFunnel(),
    getMonthlyEconomics(),
  ]);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-emerald-700">
            Portfolio view
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            VM performance
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Delivery, response, and acquisition economics at a glance.
          </p>
        </div>
        <Link className="btn-primary" href="/campaigns/new">
          New campaign <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      <section className="mt-7">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-emerald-700">
              Today · {today.date}
            </p>
            <h2 className="text-lg font-bold">Sequence operations</h2>
          </div>
          <Link
            className="text-sm font-semibold text-emerald-700"
            href="/outreach"
          >
            Open outreach queue
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            label="RVM progress"
            value={`${today.rvmProcessed.toLocaleString()} / ${today.rvmScheduled.toLocaleString()}`}
            detail={`${today.rvmRemaining.toLocaleString()} scheduled remaining`}
            icon={Voicemail}
          />
          <MetricCard
            label="Daily live allowance"
            value={today.rvmAllowanceRemaining.toLocaleString()}
            detail={`${today.rvmAttempted.toLocaleString()} attempted · safety cap ${today.environmentDailyCap.toLocaleString()}`}
            icon={Clock3}
          />
          <MetricCard
            label="SMS awaiting export"
            value={today.smsAwaitingExport.toLocaleString()}
            detail={`${today.smsEligibleToday.toLocaleString()} newly eligible`}
            icon={MessageSquareText}
          />
          <MetricCard
            label="Cold-call awaiting export"
            value={today.coldCallAwaitingExport.toLocaleString()}
            detail={`${today.coldCallEligibleToday.toLocaleString()} newly eligible`}
            icon={PhoneCall}
          />
          <MetricCard
            label="Qualified today"
            value={today.qualifiedLeads.toLocaleString()}
            detail={`${today.callbacks.toLocaleString()} callbacks · ${today.optOuts.toLocaleString()} opt-outs`}
            icon={Target}
          />
        </div>
      </section>
      <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Delivered"
          value={metrics.delivered.toLocaleString()}
          detail={`${metrics.deliveryRate.toFixed(1)}% delivery rate`}
          icon={Voicemail}
        />
        <MetricCard
          label="Callbacks"
          value={metrics.callbacks.toLocaleString()}
          detail={`${metrics.callbackRate.toFixed(2)}% of delivered`}
          icon={PhoneCall}
        />
        <MetricCard
          label="Qualified leads"
          value={metrics.qualified.toLocaleString()}
          detail={`${metrics.vaEquivalentConversations.toLocaleString()} VA-equivalent conversations`}
          icon={Target}
        />
        <MetricCard
          label="Total spend"
          value={formatCents(metrics.totalCents)}
          detail={
            metrics.costPerQualifiedLeadCents == null
              ? "No lead cost yet"
              : `${formatCents(metrics.costPerQualifiedLeadCents)} / qualified lead`
          }
          icon={BadgeDollarSign}
        />
        <MetricCard
          label="Closed revenue"
          value={formatCents(metrics.revenueCents)}
          detail={
            metrics.roiPercent == null
              ? "ROI pending"
              : `${metrics.roiPercent.toFixed(0)}% estimated ROI`
          }
          icon={Megaphone}
        />
      </section>
      <section className="mt-7 grid gap-5 xl:grid-cols-[1.15fr_1fr]">
        <div>
          <h2 className="mb-3 text-lg font-bold">Touch-separated funnel</h2>
          <div className="table-wrap overflow-x-auto">
            <table className="data-table min-w-[680px]">
              <thead>
                <tr>
                  <th>Touch</th>
                  <th>Entered</th>
                  <th>Completed / sent</th>
                  <th>Responses</th>
                  <th>Credited leads</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="font-semibold">RVM</td>
                  <td>{funnel.rvm.attempted.toLocaleString()} attempted</td>
                  <td>{funnel.rvm.successful.toLocaleString()} successful</td>
                  <td>{funnel.rvm.callbacks.toLocaleString()} callbacks</td>
                  <td>{funnel.rvm.qualifiedLeads.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="font-semibold">External SMS</td>
                  <td>{funnel.sms.eligible.toLocaleString()} eligible</td>
                  <td>{funnel.sms.sent.toLocaleString()} recorded sent</td>
                  <td>{funnel.sms.replies.toLocaleString()} replies</td>
                  <td>{funnel.sms.qualifiedLeads.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="font-semibold">Human cold call</td>
                  <td>{funnel.coldCall.eligible.toLocaleString()} eligible</td>
                  <td>{funnel.coldCall.exported.toLocaleString()} exported</td>
                  <td>
                    {funnel.coldCall.contacted.toLocaleString()} contacted
                  </td>
                  <td>{funnel.coldCall.qualifiedLeads.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-lg font-bold">Current provider period</h2>
          <div className="card divide-y divide-slate-100 px-5">
            {[
              [
                "Period",
                `${monthly.period.startsAt.toLocaleDateString()} – ${monthly.period.endsAt.toLocaleDateString()}`,
              ],
              [
                "RVM attempted / successful",
                `${monthly.attemptedRvmCount.toLocaleString()} / ${monthly.successfulRvmCount.toLocaleString()}`,
              ],
              [
                "Drop Cowboy usage value",
                formatCents(monthly.dropCowboy.usageValueCents),
              ],
              [
                "Drop Cowboy monthly minimum",
                formatCents(monthly.dropCowboy.monthlyMinimumCents),
              ],
              [
                "Drop Cowboy invoice",
                formatCents(monthly.dropCowboy.invoiceCents),
              ],
              [
                "Unused minimum credit",
                formatCents(monthly.dropCowboy.unusedMinimumCreditCents),
              ],
              [
                `${monthly.pricing.carrierProviderName} carrier fixed`,
                formatCents(monthly.carrier.fixedCents),
              ],
              [
                `Carrier usage (${monthly.carrier.durationBasis.toLowerCase()})`,
                formatCents(monthly.carrier.variableCents),
              ],
              ["Carrier total", formatCents(monthly.carrier.totalCents)],
              [
                "ElevenLabs generated",
                formatCents(monthly.elevenLabsCostCents),
              ],
              [
                "ElevenLabs characters",
                monthly.elevenLabsCharacters.toLocaleString(),
              ],
              [
                "Audio generations / reuses",
                `${monthly.generatedAudioCount.toLocaleString()} / ${monthly.audioReuseCount.toLocaleString()}`,
              ],
              [
                "Infrastructure overhead",
                formatCents(monthly.infrastructureCents),
              ],
              ["Total period cost", formatCents(monthly.periodTotalCents)],
            ].map(([label, value]) => (
              <div
                className="flex items-center justify-between gap-4 py-3"
                key={label}
              >
                <span className="text-sm text-slate-600">{label}</span>
                <strong className="text-right text-sm">{value}</strong>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Shared minimum and fixed costs are allocated to campaigns by
            successful RVMs and attempts, using deterministic largest-remainder
            rounding. With no basis units, they remain unallocated account
            overhead.
          </p>
        </div>
      </section>
      <section className="mt-7 grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-bold">Recent campaigns</h2>
            <Link
              className="text-sm font-semibold text-emerald-700"
              href="/campaigns"
            >
              View all
            </Link>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Status</th>
                  <th>Eligible</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id}>
                    <td>
                      <Link
                        className="font-semibold text-slate-950 hover:text-emerald-700"
                        href={`/campaigns/${campaign.id}`}
                      >
                        {campaign.name}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={campaign.status} />
                    </td>
                    <td>{campaign.eligibleCount.toLocaleString()}</td>
                    <td>{campaign.createdAt.toLocaleDateString()}</td>
                  </tr>
                ))}
                {!campaigns.length ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="py-10 text-center text-slate-500"
                    >
                      No campaigns yet. Import a list to get started.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-lg font-bold">Unit economics</h2>
          <div className="card divide-y divide-slate-100 px-5">
            {[
              ["Cost / successful RVM", metrics.costPerDeliveredCents],
              ["Cost / attempted RVM", metrics.costPerAttemptedCents],
              ["Cost / callback", metrics.costPerCallbackCents],
              ["Cost / interested seller", metrics.costPerInterestedCents],
              ["Cost / qualified lead", metrics.costPerQualifiedLeadCents],
              ["Cost / contract", metrics.costPerContractCents],
              ["Cost / closed deal", metrics.actualCostPerClosedDealCents],
              ["VA cost / qualified lead", metrics.vaCostPerQualifiedLeadCents],
              [
                "VA expected labor / deal",
                metrics.vaExpectedLaborCostPerDealCents,
              ],
            ].map(([label, value]) => (
              <div
                className="flex items-center justify-between py-3.5"
                key={String(label)}
              >
                <span className="text-sm text-slate-600">{label}</span>
                <strong className="text-sm">
                  {value == null ? "—" : formatCents(Number(value))}
                </strong>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
