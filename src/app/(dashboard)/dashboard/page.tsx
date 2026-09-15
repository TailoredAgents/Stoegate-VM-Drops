import {
  ArrowRight,
  BadgeDollarSign,
  Download,
  MessageSquareReply,
  PhoneCall,
  Send,
  ShieldCheck,
  Target,
} from "lucide-react";
import Link from "next/link";

import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import {
  getCampaignMetrics,
  getOutreachFunnel,
  getTodayOperations,
} from "@/lib/analytics";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/utils";

function money(value: number | null) {
  return value == null ? "—" : formatCents(value);
}

export default async function DashboardPage() {
  const [metrics, campaigns, today, funnel] = await Promise.all([
    getCampaignMetrics(),
    db.campaign.findMany({
      where: { kind: "SMS" },
      orderBy: { createdAt: "desc" },
      take: 6,
      include: { _count: { select: { contacts: true } } },
    }),
    getTodayOperations(),
    getOutreachFunnel(),
  ]);
  const economicsRows: Array<{
    label: string;
    value: number | null;
    requiresComparableProviderCost?: boolean;
  }> = [
    {
      label: "Current variable SMS spend",
      value: metrics.totalCostCents,
      requiresComparableProviderCost: true,
    },
    {
      label: "Configured fixed monthly run-rate",
      value: metrics.configuredFixedMonthlyCents,
    },
    {
      label: "Cost / sent",
      value: metrics.costPerSentCents,
      requiresComparableProviderCost: true,
    },
    {
      label: "Cost / delivered",
      value: metrics.costPerDeliveredCents,
      requiresComparableProviderCost: true,
    },
    {
      label: "Cost / reply",
      value: metrics.costPerReplyCents,
      requiresComparableProviderCost: true,
    },
    {
      label: "Cost / interested seller",
      value: metrics.costPerInterestedCents,
      requiresComparableProviderCost: true,
    },
    {
      label: "Cost / qualified lead",
      value: metrics.costPerQualifiedLeadCents,
      requiresComparableProviderCost: true,
    },
    {
      label: "Cost / contract",
      value: metrics.costPerContractCents,
      requiresComparableProviderCost: true,
    },
    {
      label: "Cost / closed deal",
      value: metrics.costPerClosedDealCents,
      requiresComparableProviderCost: true,
    },
    {
      label: "VA benchmark / qualified lead",
      value: metrics.vaCostPerQualifiedLeadCents,
    },
    {
      label: "VA expected labor / deal",
      value: metrics.vaExpectedLaborCostPerDealCents,
    },
  ];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-emerald-700">
            Portfolio view
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            SMS performance
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Delivery, seller response, BatchDialer handoff, attribution, and
            acquisition economics.
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
            <h2 className="text-lg font-bold">Operating pulse</h2>
          </div>
          <Link
            className="text-sm font-semibold text-emerald-700"
            href="/operations"
          >
            Open operations
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            label="Live SMS remaining"
            value={
              today.liveSendsEnabled
                ? today.globalAllowanceRemaining.toLocaleString()
                : "Disabled"
            }
            detail={`${today.globalAttempted.toLocaleString()} reserved · ${today.globalAllowanceRemaining.toLocaleString()} remaining under ${today.globalDailyCap.toLocaleString()}/day cap`}
            icon={ShieldCheck}
          />
          <MetricCard
            label="Sent today"
            value={today.smsSent.toLocaleString()}
            detail={`${today.smsDelivered.toLocaleString()} delivered`}
            icon={Send}
          />
          <MetricCard
            label="Replies today"
            value={today.replies.toLocaleString()}
            detail={`${today.interested.toLocaleString()} interested · ${today.optOuts.toLocaleString()} opt-outs`}
            icon={MessageSquareReply}
          />
          <MetricCard
            label="Qualified today"
            value={today.qualifiedLeads.toLocaleString()}
            detail={`${today.coldCallQualifiedLeads.toLocaleString()} credited to cold call`}
            icon={Target}
          />
          <MetricCard
            label="Awaiting BatchDialer"
            value={funnel.batchDialer.eligible.toLocaleString()}
            detail={`${today.batchDialerEligible.toLocaleString()} became eligible today`}
            icon={Download}
          />
        </div>
      </section>

      <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard
          label="Sent"
          value={metrics.sent.toLocaleString()}
          detail={`${metrics.accepted.toLocaleString()} accepted`}
          icon={Send}
        />
        <MetricCard
          label="Delivered"
          value={metrics.delivered.toLocaleString()}
          detail={`${metrics.deliveryRate.toFixed(1)}% of sent`}
          icon={Send}
        />
        <MetricCard
          label="Replies"
          value={metrics.replies.toLocaleString()}
          detail={`${metrics.replyRate.toFixed(1)}% of sent`}
          icon={MessageSquareReply}
        />
        <MetricCard
          label="Opt-outs"
          value={metrics.optOuts.toLocaleString()}
          detail={`${metrics.optOutRate.toFixed(1)}% of sent`}
          icon={ShieldCheck}
        />
        <MetricCard
          label="Qualified leads"
          value={metrics.qualified.toLocaleString()}
          detail={`${metrics.channelAttribution.sms.toLocaleString()} SMS · ${metrics.channelAttribution.coldCall.toLocaleString()} cold-call`}
          icon={Target}
        />
        <MetricCard
          label="SMS variable cost"
          value={
            metrics.costsComparable && metrics.totalCostCents !== null
              ? formatCents(metrics.totalCostCents)
              : "Unavailable"
          }
          detail={
            metrics.costsComparable
              ? `${formatCents(metrics.configuredFixedMonthlyCents)}/mo fixed run-rate`
              : metrics.hasMixedCurrencies
                ? "Multiple currencies; no FX conversion applied"
                : `${metrics.currency} provider cost cannot be combined with USD settings`
          }
          icon={BadgeDollarSign}
        />
      </section>

      <section className="mt-7 grid gap-5 xl:grid-cols-[1.25fr_1fr]">
        <div>
          <h2 className="mb-3 text-lg font-bold">Acquisition funnel</h2>
          <div className="table-wrap overflow-x-auto">
            <table className="data-table min-w-[680px]">
              <thead>
                <tr>
                  <th>Channel / step</th>
                  <th>Entered</th>
                  <th>Progress</th>
                  <th>Responses</th>
                  <th>Qualified leads</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="font-semibold">SMS</td>
                  <td>{funnel.sms.attempted.toLocaleString()} attempted</td>
                  <td>{funnel.sms.delivered.toLocaleString()} delivered</td>
                  <td>{funnel.sms.replies.toLocaleString()} replies</td>
                  <td>{funnel.sms.qualifiedLeads.toLocaleString()}</td>
                </tr>
                <tr>
                  <td className="font-semibold">BatchDialer handoff</td>
                  <td>
                    {funnel.batchDialer.eligible.toLocaleString()} eligible
                  </td>
                  <td>
                    {funnel.batchDialer.exported.toLocaleString()} exported
                  </td>
                  <td>—</td>
                  <td>—</td>
                </tr>
                <tr>
                  <td className="font-semibold">Human cold call</td>
                  <td>
                    {funnel.batchDialer.exported.toLocaleString()} exported
                  </td>
                  <td>
                    {funnel.coldCall.contacted.toLocaleString()} contacted
                  </td>
                  <td>
                    {funnel.coldCall.contracts.toLocaleString()} contracts
                  </td>
                  <td>{funnel.coldCall.qualifiedLeads.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h2 className="mb-3 text-lg font-bold">Channel attribution</h2>
          <div className="card divide-y divide-slate-100 px-5">
            {[
              ["SMS-qualified leads", metrics.channelAttribution.sms],
              [
                "Cold-call leads after SMS",
                metrics.channelAttribution.coldCall,
              ],
              ["Other credited leads", metrics.channelAttribution.other],
              ["Combined qualified leads", metrics.qualified],
              ["SMS contracts", metrics.smsContracts],
              ["Cold-call contracts", metrics.coldCallContracts],
              ["Contracts, all channels", metrics.contracts],
              ["Closed deals", metrics.closed],
            ].map(([label, value]) => (
              <div
                className="flex items-center justify-between gap-4 py-3"
                key={String(label)}
              >
                <span className="text-sm text-slate-600">{label}</span>
                <strong className="text-sm">
                  {Number(value).toLocaleString()}
                </strong>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-7 grid gap-5 xl:grid-cols-[1.4fr_1fr]">
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
                  <th>Contacts</th>
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
                    <td>{campaign._count.contacts.toLocaleString()}</td>
                    <td>{campaign.createdAt.toLocaleDateString()}</td>
                  </tr>
                ))}
                {!campaigns.length ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="py-10 text-center text-slate-500"
                    >
                      No SMS campaigns yet. Import a list to get started.
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
            {economicsRows.map((row) => (
              <div
                className="flex items-center justify-between gap-4 py-3"
                key={row.label}
              >
                <span className="text-sm text-slate-600">{row.label}</span>
                <strong className="text-sm">
                  {money(
                    row.requiresComparableProviderCost &&
                      !metrics.costsComparable
                      ? null
                      : row.value,
                  )}
                </strong>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Provider pricing is configuration-driven. Actual reported message
            cost replaces that message&apos;s estimate when available; no
            carrier price is hardcoded. Fixed monthly fees are shown separately
            and are not allocated into per-result costs without an explicit
            allocation policy. Mixed or non-USD provider costs stay recorded,
            but combined unit economics remain unavailable until an FX policy is
            configured.
          </p>
        </div>
      </section>

      <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Nonresponders"
          value={metrics.nonresponders.toLocaleString()}
          detail={`${metrics.nonresponseRate.toFixed(1)}% of sent`}
          icon={PhoneCall}
        />
        <MetricCard
          label="BatchDialer exported"
          value={metrics.batchDialerExported.toLocaleString()}
          detail={`${metrics.batchDialerExportRate.toFixed(1)}% of handoff pool`}
          icon={Download}
        />
        <MetricCard
          label="Cold-call leads"
          value={metrics.coldCallQualifiedLeads.toLocaleString()}
          detail={`${metrics.coldCallContacted.toLocaleString()} contacted`}
          icon={PhoneCall}
        />
        <MetricCard
          label="Provider actual coverage"
          value={`${metrics.providerActualCoverageRate.toFixed(1)}%`}
          detail={`${metrics.messagesUsingEstimatedCost.toLocaleString()} messages still estimated`}
          icon={BadgeDollarSign}
        />
      </section>
    </>
  );
}
