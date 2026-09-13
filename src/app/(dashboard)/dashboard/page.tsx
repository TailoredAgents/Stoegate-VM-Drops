import Link from "next/link";
import {
  ArrowRight,
  BadgeDollarSign,
  Megaphone,
  PhoneCall,
  Target,
  Voicemail,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import { getCampaignMetrics } from "@/lib/analytics";
import { db } from "@/lib/db";
import { formatCents } from "@/lib/utils";

export default async function DashboardPage() {
  const [metrics, campaigns] = await Promise.all([
    getCampaignMetrics(),
    db.campaign.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      include: { _count: { select: { contacts: true } } },
    }),
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
              ["Cost / delivered VM", metrics.costPerDeliveredCents],
              ["Cost / callback", metrics.costPerCallbackCents],
              ["Cost / interested seller", metrics.costPerInterestedCents],
              ["Cost / qualified lead", metrics.costPerQualifiedLeadCents],
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
