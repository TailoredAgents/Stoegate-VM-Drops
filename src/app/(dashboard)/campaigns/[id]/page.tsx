import Link from "next/link";
import {
  ArrowLeft,
  BadgeDollarSign,
  MessageSquareReply,
  Send,
  Target,
} from "lucide-react";
import { notFound } from "next/navigation";

import { CampaignActionPanel } from "@/components/campaign-action-panel";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { estimateSmsSegments } from "@/lib/sms";
import { formatCents, percent } from "@/lib/utils";

const PAGE_SIZE = 50;

function numericJson(value: unknown, key: string, fallback = 0): number {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, candidate)
    : fallback;
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { id } = await params;
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const [
    campaign,
    totalContacts,
    previews,
    sent,
    delivered,
    failed,
    replies,
    qualified,
    coldCallEligible,
    coldCallExported,
    actualCosts,
    estimatedCosts,
    env,
  ] = await Promise.all([
    db.campaign.findFirst({
      where: { id, kind: "SMS" },
      include: {
        smsTemplateVersion: { include: { template: true } },
        createdBy: { select: { email: true } },
        approvedBy: { select: { email: true } },
        launchedBy: { select: { email: true } },
        contacts: {
          orderBy: { createdAt: "asc" },
          skip: (page - 1) * PAGE_SIZE,
          take: PAGE_SIZE,
          include: {
            contact: true,
            property: true,
            outboundMessages: {
              orderBy: { sequenceNumber: "asc" },
              take: 1,
            },
            inboundMessages: {
              orderBy: { receivedAt: "desc" },
              take: 1,
            },
            outreachSequence: true,
            leadAttribution: true,
          },
        },
      },
    }),
    db.campaignContact.count({ where: { campaignId: id } }),
    db.campaignContact.findMany({
      where: { campaignId: id, isPreview: true },
      include: { contact: true, property: true },
      orderBy: { createdAt: "asc" },
      take: 25,
    }),
    db.smsOutboundMessage.count({
      where: { campaignContact: { campaignId: id }, sentAt: { not: null } },
    }),
    db.smsOutboundMessage.count({
      where: {
        campaignContact: { campaignId: id },
        deliveredAt: { not: null },
      },
    }),
    db.smsOutboundMessage.count({
      where: {
        campaignContact: { campaignId: id },
        status: { in: ["FAILED", "UNDELIVERED"] },
      },
    }),
    db.smsInboundMessage.count({
      where: { campaignContact: { campaignId: id } },
    }),
    db.leadAttribution.count({ where: { campaignId: id } }),
    db.outreachSequence.count({
      where: {
        campaignContact: { campaignId: id },
        currentState: "COLD_CALL_ELIGIBLE",
      },
    }),
    db.outreachSequence.count({
      where: {
        campaignContact: { campaignId: id },
        currentState: "COLD_CALL_EXPORTED",
      },
    }),
    db.smsOutboundMessage.aggregate({
      where: {
        campaignContact: { campaignId: id },
        actualCostMicros: { not: null },
      },
      _sum: { actualCostMicros: true },
    }),
    db.smsOutboundMessage.aggregate({
      where: {
        campaignContact: { campaignId: id },
        actualCostMicros: null,
      },
      _sum: { estimatedCostMicros: true },
    }),
    getEnv(),
  ]);
  if (!campaign) notFound();

  const avgSegments = previews.length
    ? previews.reduce(
        (total, preview) =>
          total + estimateSmsSegments(preview.renderedText ?? "").segmentCount,
        0,
      ) / previews.length
    : estimateSmsSegments(campaign.smsTemplateVersion?.body ?? "").segmentCount;
  const outboundMessageMicros = numericJson(
    campaign.smsCostConfig,
    "costPerOutboundMessageMicros",
  );
  const segmentMicros = numericJson(
    campaign.smsCostConfig,
    "costPerSegmentMicros",
    campaign.smsEstimatedCostPerSegmentMicros,
  );
  const plannedCount = Math.min(campaign.eligibleCount, campaign.sendLimit);
  const plannedVariableCostCents =
    (plannedCount * (outboundMessageMicros + avgSegments * segmentMicros)) /
    10_000;
  const recordedVariableCostCents =
    ((actualCosts._sum.actualCostMicros ?? 0) +
      (estimatedCosts._sum.estimatedCostMicros ?? 0)) /
    10_000;

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
            {campaign.smsTemplateVersion
              ? campaign.smsTemplateVersion.template.name +
                " v" +
                campaign.smsTemplateVersion.version
              : "No SMS template"}
            {" · "}
            {campaign.sourceName || "No source label"}
            {" · "}
            {campaign.smsScheduleTimezone}
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-right">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Planned variable cost
          </p>
          <p className="text-xl font-bold">
            {formatCents(plannedVariableCostCents)}
          </p>
        </div>
      </div>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Sent"
          value={sent.toLocaleString()}
          detail={`${delivered.toLocaleString()} delivered · ${percent(delivered, sent).toFixed(1)}%`}
          icon={Send}
        />
        <MetricCard
          label="Replies"
          value={replies.toLocaleString()}
          detail={`${percent(replies, sent).toFixed(1)}% reply rate`}
          icon={MessageSquareReply}
        />
        <MetricCard
          label="Qualified leads"
          value={qualified.toLocaleString()}
          detail={`${percent(qualified, sent).toFixed(2)}% of sent`}
          icon={Target}
        />
        <MetricCard
          label="Recorded SMS cost"
          value={formatCents(recordedVariableCostCents)}
          detail={`${failed.toLocaleString()} failed or undelivered`}
          icon={BadgeDollarSign}
        />
      </section>

      <section className="mt-6 grid gap-5 xl:grid-cols-[1fr_330px]">
        <div className="space-y-5">
          <div className="card p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-bold">Import and handoff</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Cleaned list totals and the current BatchDialer queue.
                </p>
              </div>
              <strong className="text-2xl">
                {campaign.eligibleCount.toLocaleString()}
              </strong>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {[
                ["Uploaded", campaign.uploadedCount],
                ["Eligible", campaign.eligibleCount],
                ["Duplicates", campaign.duplicateCount],
                ["Suppressed", campaign.suppressedCount],
                ["Invalid", campaign.invalidCount],
                ["Call eligible", coldCallEligible],
                ["Exported", coldCallExported],
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
                <h2 className="font-bold">Personalized preview</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Review the actual owner/property text and its SMS encoding
                  before approval.
                </p>
              </div>
              <span className="text-sm font-semibold text-slate-500">
                {previews.length} selected
              </span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {previews.map((preview) => {
                const analysis = estimateSmsSegments(
                  preview.renderedText ?? "",
                );
                return (
                  <article className="card p-4" key={preview.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-semibold">
                          {preview.contact.ownerName ||
                            preview.contact.firstName ||
                            "Unnamed owner"}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          {preview.property?.propertyAddress ||
                            "No property address"}
                        </p>
                      </div>
                      <span className="whitespace-nowrap text-xs text-slate-500">
                        {analysis.encoding} · {analysis.segmentCount} segment
                        {analysis.segmentCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                      {preview.renderedText || "Preview has not been rendered."}
                    </p>
                  </article>
                );
              })}
              {!previews.length ? (
                <div className="card col-span-full p-8 text-center text-sm text-slate-500">
                  Render a preview sample to review personalized messages before
                  approval.
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
          dailyCap={campaign.smsDailyCap}
          estimatedCost={formatCents(plannedVariableCostCents)}
          liveSms={env.SMS_LIVE_SENDS_ENABLED}
        />
      </section>

      <section className="mt-7">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">Recipients</h2>
          <span className="text-xs text-slate-500">
            {totalContacts.toLocaleString()} total · {PAGE_SIZE} per page
          </span>
        </div>
        <div className="table-wrap overflow-x-auto">
          <table className="data-table min-w-[850px]">
            <thead>
              <tr>
                <th>Owner / phone</th>
                <th>Property</th>
                <th>SMS</th>
                <th>Latest reply</th>
                <th>Sequence / attribution</th>
              </tr>
            </thead>
            <tbody>
              {campaign.contacts.map((cc) => {
                const message = cc.outboundMessages[0];
                const reply = cc.inboundMessages[0];
                return (
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
                        {[
                          cc.property?.city,
                          cc.property?.state,
                          cc.property?.county,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                    </td>
                    <td>
                      <StatusBadge status={message?.status ?? cc.status} />
                      {message ? (
                        <p className="mt-1 text-[11px] text-slate-500">
                          {message.segmentCount} segment
                          {message.segmentCount === 1 ? "" : "s"}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      {reply ? (
                        <>
                          <StatusBadge status={reply.classification} />
                          <p className="mt-1 max-w-56 truncate text-xs text-slate-500">
                            {reply.body}
                          </p>
                        </>
                      ) : (
                        <span className="text-slate-400">No reply</span>
                      )}
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
                );
              })}
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
          {page * PAGE_SIZE < totalContacts ? (
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
