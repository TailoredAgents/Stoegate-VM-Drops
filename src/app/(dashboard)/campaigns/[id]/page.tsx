import Link from "next/link";
import {
  ArrowLeft,
  BadgeDollarSign,
  PhoneCall,
  Target,
  Voicemail,
} from "lucide-react";
import { notFound } from "next/navigation";
import { CampaignActionPanel } from "@/components/campaign-action-panel";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import { getCampaignMetrics, getOutreachFunnel } from "@/lib/analytics";
import { db } from "@/lib/db";
import { getNumericSettings } from "@/lib/settings";
import { formatCents } from "@/lib/utils";

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const [campaign, metrics, settings, funnel] = await Promise.all([
    db.campaign.findUnique({
      where: { id },
      include: {
        scriptTemplateVersion: { include: { template: true } },
        voiceConfiguration: true,
        contacts: {
          orderBy: { createdAt: "asc" },
          skip: (page - 1) * 50,
          take: 50,
          include: {
            contact: true,
            property: true,
            audioAssets: {
              where: { status: "READY" },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
            drops: { take: 1 },
            outreachSequence: true,
            leadAttribution: true,
          },
        },
      },
    }),
    getCampaignMetrics(id),
    getNumericSettings(),
    getOutreachFunnel(id),
  ]);
  if (!campaign) notFound();
  const previews = await db.campaignContact.findMany({
    where: { campaignId: id, isPreview: true },
    include: {
      contact: true,
      property: true,
      audioAssets: {
        where: { status: "READY" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    take: 25,
  });
  const averageCharacters = previews.length
    ? Math.round(
        previews.reduce(
          (sum, row) => sum + (row.audioAssets[0]?.characterCount ?? 0),
          0,
        ) / previews.length,
      )
    : (campaign.scriptTemplateVersion?.body.length ?? 0);
  const maxSends = Math.min(campaign.eligibleCount, campaign.sendLimit);
  const estimatedCost = Math.round(
    ((averageCharacters * maxSends) / 1000) *
      settings.elevenlabs_cost_per_1000_chars_cents +
      maxSends *
        (settings.drop_cowboy_success_cost_cents +
          (settings.carrier_average_seconds_per_attempt / 60) *
            settings.carrier_voice_cents_per_minute),
  );
  const optionalCents = (value: number | null) =>
    value == null ? "—" : formatCents(value);
  return (
    <>
      <Link
        className="inline-flex items-center gap-1 text-sm font-semibold text-slate-500 hover:text-slate-900"
        href="/campaigns"
      >
        <ArrowLeft className="h-4 w-4" />
        Campaigns
      </Link>
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">
              {campaign.name}
            </h1>
            <StatusBadge status={campaign.status} />
          </div>
          <p className="mt-2 text-sm text-slate-500">
            {campaign.scriptTemplateVersion?.template.name ?? "No script"} ·{" "}
            {campaign.voiceConfiguration?.name ?? "No voice"} · created{" "}
            {campaign.createdAt.toLocaleDateString()}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Estimated marginal usage
          </p>
          <p className="text-xl font-bold">{formatCents(estimatedCost)}</p>
        </div>
      </div>
      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Delivered"
          value={metrics.delivered.toLocaleString()}
          detail={`${metrics.deliveryRate.toFixed(1)}% delivery rate`}
          icon={Voicemail}
        />
        <MetricCard
          label="Callbacks"
          value={metrics.callbacks.toLocaleString()}
          detail={`${metrics.callbackRate.toFixed(2)}% callback rate`}
          icon={PhoneCall}
        />
        <MetricCard
          label="Qualified leads"
          value={metrics.qualified.toLocaleString()}
          detail={`${funnel.rvm.qualifiedLeads.toLocaleString()} RVM · ${funnel.sms.qualifiedLeads.toLocaleString()} SMS · ${funnel.coldCall.qualifiedLeads.toLocaleString()} cold-call`}
          icon={Target}
        />
        <MetricCard
          label="Campaign spend"
          value={formatCents(metrics.totalCents)}
          detail={
            metrics.costPerQualifiedLeadCents == null
              ? "Lead cost pending"
              : `${formatCents(metrics.costPerQualifiedLeadCents)} / lead`
          }
          icon={BadgeDollarSign}
        />
      </section>
      <section className="mt-6 grid gap-5 xl:grid-cols-[1.2fr_1fr]">
        <div className="table-wrap overflow-x-auto">
          <table className="data-table min-w-[650px]">
            <thead>
              <tr>
                <th>Touch</th>
                <th>Eligible / attempted</th>
                <th>Sent / successful</th>
                <th>Responses</th>
                <th>Credited leads</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="font-semibold">RVM</td>
                <td>{funnel.rvm.attempted.toLocaleString()}</td>
                <td>{funnel.rvm.successful.toLocaleString()}</td>
                <td>{funnel.rvm.callbacks.toLocaleString()} callbacks</td>
                <td>{funnel.rvm.qualifiedLeads.toLocaleString()}</td>
              </tr>
              <tr>
                <td className="font-semibold">External SMS</td>
                <td>{funnel.sms.eligible.toLocaleString()}</td>
                <td>{funnel.sms.sent.toLocaleString()}</td>
                <td>{funnel.sms.replies.toLocaleString()} replies</td>
                <td>{funnel.sms.qualifiedLeads.toLocaleString()}</td>
              </tr>
              <tr>
                <td className="font-semibold">Human cold call</td>
                <td>{funnel.coldCall.eligible.toLocaleString()}</td>
                <td>{funnel.coldCall.exported.toLocaleString()} exported</td>
                <td>{funnel.coldCall.contacted.toLocaleString()} contacted</td>
                <td>{funnel.coldCall.qualifiedLeads.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="card divide-y divide-slate-100 px-5">
          {[
            ["ElevenLabs generation", formatCents(metrics.ttsCents)],
            [
              "ElevenLabs characters",
              metrics.elevenLabsCharacters.toLocaleString(),
            ],
            [
              "Audio generations / reuses",
              `${metrics.audioGenerated.toLocaleString()} / ${metrics.audioReuseCount.toLocaleString()}`,
            ],
            [
              "Drop Cowboy marginal usage",
              formatCents(metrics.marginalDropCowboyCents),
            ],
            [
              "Allocated Drop Cowboy invoice",
              formatCents(metrics.allocatedDropCowboyCents),
            ],
            ["Allocated carrier fixed", formatCents(metrics.carrierFixedCents)],
            ["Carrier usage", formatCents(metrics.carrierVariableCents)],
            ["Carrier total", formatCents(metrics.carrierTotalCents)],
            [
              "Infrastructure allocation",
              formatCents(metrics.infrastructureCents),
            ],
            ["Total attributable", formatCents(metrics.totalCents)],
            [
              "Cost / attempted RVM",
              optionalCents(metrics.costPerAttemptedCents),
            ],
            [
              "Cost / successful RVM",
              optionalCents(metrics.costPerDeliveredCents),
            ],
            ["Cost / callback", optionalCents(metrics.costPerCallbackCents)],
            [
              "Cost / interested seller",
              optionalCents(metrics.costPerInterestedCents),
            ],
            [
              "Cost / qualified lead",
              optionalCents(metrics.costPerQualifiedLeadCents),
            ],
            ["Cost / contract", optionalCents(metrics.costPerContractCents)],
            [
              "Cost / closed deal",
              optionalCents(metrics.actualCostPerClosedDealCents),
            ],
          ].map(([label, value]) => (
            <div
              className="flex items-center justify-between py-3"
              key={String(label)}
            >
              <span className="text-sm text-slate-600">{label}</span>
              <strong className="text-right text-sm">{value}</strong>
            </div>
          ))}
          <p className="py-3 text-xs leading-5 text-slate-500">
            Marginal usage is informational and is not added again to the
            allocated monthly invoice cost.
          </p>
        </div>
      </section>
      <section className="mt-6 grid gap-5 xl:grid-cols-[1fr_330px]">
        <div className="space-y-5">
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold">Import quality</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Final classification before campaign creation.
                </p>
              </div>
              <strong className="text-2xl">
                {campaign.eligibleCount.toLocaleString()}
              </strong>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
              {[
                ["Uploaded", campaign.uploadedCount],
                ["Eligible", campaign.eligibleCount],
                ["Duplicates", campaign.duplicateCount],
                ["Suppressed", campaign.suppressedCount],
                ["Invalid", campaign.invalidCount],
              ].map(([label, value]) => (
                <div className="rounded-lg bg-slate-50 p-3" key={String(label)}>
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="mt-1 font-bold">
                    {Number(value).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="font-bold">Preview approvals</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Random personalized messages selected from eligible contacts.
                </p>
              </div>
              <span className="text-sm font-semibold text-slate-500">
                {previews.length} selected
              </span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {previews.map((preview) => {
                const audio = preview.audioAssets[0];
                return (
                  <article className="card p-4" key={preview.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">
                          {preview.contact.ownerName ||
                            [
                              preview.contact.firstName,
                              preview.contact.lastName,
                            ]
                              .filter(Boolean)
                              .join(" ") ||
                            "Unnamed owner"}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {preview.property?.propertyAddress ||
                            "No property address"}
                        </p>
                      </div>
                      <StatusBadge status={audio?.status ?? "PENDING"} />
                    </div>
                    <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-600">
                      {audio?.renderedText ||
                        preview.renderedText ||
                        "Audio generation queued."}
                    </p>
                    {audio ? (
                      <audio
                        className="mt-3 h-9 w-full"
                        controls
                        preload="none"
                        src={`/api/audio/${audio.id}`}
                      />
                    ) : null}
                  </article>
                );
              })}
              {!previews.length ? (
                <div className="card col-span-full p-8 text-center text-sm text-slate-500">
                  Generate a preview sample to review rendered scripts and audio
                  before approval.
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <CampaignActionPanel
          id={campaign.id}
          name={campaign.name}
          status={campaign.status}
          eligible={campaign.eligibleCount}
          sendLimit={campaign.sendLimit}
          estimatedCost={formatCents(estimatedCost)}
        />
      </section>
      <section className="mt-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">Recipients</h2>
          <span className="text-xs text-slate-500">50 per page</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Owner / phone</th>
                <th>Property</th>
                <th>Audio</th>
                <th>Drop</th>
                <th>Sequence</th>
              </tr>
            </thead>
            <tbody>
              {campaign.contacts.map((cc) => (
                <tr key={cc.id}>
                  <td>
                    <p className="font-semibold text-slate-950">
                      {cc.contact.ownerName ||
                        cc.contact.firstName ||
                        "Unnamed"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {cc.contact.normalizedPhone}
                    </p>
                  </td>
                  <td>
                    <p>{cc.property?.propertyAddress || "—"}</p>
                    <p className="text-xs text-slate-500">
                      {[cc.property?.city, cc.property?.state]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  </td>
                  <td>
                    <StatusBadge
                      status={cc.audioAssets[0]?.status ?? "PENDING"}
                    />
                  </td>
                  <td>
                    <StatusBadge status={cc.drops[0]?.status ?? cc.status} />
                  </td>
                  <td>
                    <StatusBadge
                      status={
                        cc.outreachSequence?.currentState ?? "NOT_ENROLLED"
                      }
                    />
                    {cc.leadAttribution ? (
                      <p className="mt-1 text-[11px] text-slate-500">
                        Lead:{" "}
                        {cc.leadAttribution.creditedChannel.replaceAll(
                          "_",
                          " ",
                        )}
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {page > 1 ? (
            <Link
              className="btn-secondary"
              href={`/campaigns/${id}?page=${page - 1}`}
            >
              Previous
            </Link>
          ) : null}
          {campaign.contacts.length === 50 ? (
            <Link
              className="btn-secondary"
              href={`/campaigns/${id}?page=${page + 1}`}
            >
              Next
            </Link>
          ) : null}
        </div>
      </section>
    </>
  );
}
