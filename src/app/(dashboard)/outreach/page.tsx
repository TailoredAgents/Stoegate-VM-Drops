import Link from "next/link";
import {
  AttributionChannel,
  OutreachSequenceState,
  Prisma,
} from "@prisma/client";
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  MessageSquareText,
  PhoneCall,
  Voicemail,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import {
  ExternalOutcomeImport,
  MarkSmsSentButton,
  OutreachExportControls,
} from "@/components/outreach-actions";
import { StatusBadge } from "@/components/status-badge";
import { getTodayOperations } from "@/lib/analytics";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  campaignSpecificSourceFilter,
  previewOutreachExport,
} from "@/lib/outreach-exports";
import { getAppSettings } from "@/lib/settings";
import { getLocalDayBounds, zonedDateTimeToUtc } from "@/lib/time";

const defaultQueueStates: OutreachSequenceState[] = [
  "SMS_NOT_YET_ELIGIBLE",
  "SMS_ELIGIBLE",
  "SMS_EXPORTED",
  "SMS_SENT_EXTERNAL",
  "SMS_FAILED",
  "COLD_CALL_ELIGIBLE",
  "COLD_CALL_EXPORTED",
];

export default async function OutreachPage({
  searchParams,
}: {
  searchParams: Promise<{
    campaign?: string;
    stage?: string;
    date?: string;
    source?: string;
    channel?: string;
    page?: string;
  }>;
}) {
  const query = await searchParams;
  const user = await requireUser();
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = 50;
  const stage = Object.values(OutreachSequenceState).includes(
    query.stage as OutreachSequenceState,
  )
    ? (query.stage as OutreachSequenceState)
    : undefined;
  const responseChannel = Object.values(AttributionChannel).includes(
    query.channel as AttributionChannel,
  )
    ? (query.channel as AttributionChannel)
    : undefined;
  const [settings, campaigns] = await Promise.all([
    getAppSettings(),
    db.campaign.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    }),
  ]);
  const campaignId = campaigns.some(
    (campaign) => campaign.id === query.campaign,
  )
    ? query.campaign
    : undefined;
  const source = query.source?.trim() || undefined;
  const date = validIsoDate(query.date);
  const campaignSourcePredicate = campaignId
    ? Prisma.sql`AND cc."campaignId" = ${campaignId}::uuid`
    : Prisma.empty;
  const sourceRows = await db.$queryRaw<Array<{ source: string }>>(Prisma.sql`
    SELECT DISTINCT
      COALESCE(NULLIF(BTRIM(ir."mappedData"->>'source'), ''), p."source") AS "source"
    FROM "CampaignContact" cc
    LEFT JOIN "ImportRow" ir ON ir."id" = cc."importRowId"
    LEFT JOIN "Property" p ON p."id" = cc."propertyId"
    WHERE COALESCE(NULLIF(BTRIM(ir."mappedData"->>'source'), ''), p."source") IS NOT NULL
      ${campaignSourcePredicate}
    ORDER BY "source" ASC
  `);
  let dateFilter: Prisma.DateTimeFilter | undefined;
  if (date) {
    const [year, month, day] = date.split("-").map(Number);
    const reference = zonedDateTimeToUtc(
      { year, month, day, hour: 12, minute: 0 },
      settings.operations_timezone,
    );
    const bounds = getLocalDayBounds(reference, settings.operations_timezone);
    dateFilter = { gte: bounds.start, lt: bounds.end };
  }
  const campaignContactFilters: Prisma.CampaignContactWhereInput[] = [];
  if (campaignId) campaignContactFilters.push({ campaignId });
  if (source) campaignContactFilters.push(campaignSpecificSourceFilter(source));
  const responseEventWhere: Prisma.OutreachEventWhereInput | undefined =
    responseChannel === "RVM_CALLBACK"
      ? {
          channel: "RVM",
          type: { in: ["RVM_CALLBACK", "OUTCOME_RECORDED"] },
        }
      : responseChannel === "SMS"
        ? {
            channel: "SMS",
            type: { in: ["SMS_REPLIED", "OUTCOME_RECORDED"] },
          }
        : responseChannel === "COLD_CALL"
          ? {
              channel: "COLD_CALL",
              type: {
                in: [
                  "COLD_CALL_CONTACTED",
                  "COLD_CALL_NO_ANSWER",
                  "OUTCOME_RECORDED",
                ],
              },
            }
          : responseChannel === "OTHER"
            ? { channel: "SYSTEM", type: "OUTCOME_RECORDED" }
            : undefined;
  const scopedWhere: Prisma.OutreachSequenceWhereInput = {
    ...(dateFilter ? { lastEventAt: dateFilter } : {}),
    ...(campaignContactFilters.length
      ? { campaignContact: { AND: campaignContactFilters } }
      : {}),
    ...(responseEventWhere ? { events: { some: responseEventWhere } } : {}),
  };
  const where: Prisma.OutreachSequenceWhereInput = {
    ...scopedWhere,
    ...(stage
      ? { currentState: stage }
      : responseChannel
        ? {}
        : { currentState: { in: defaultQueueStates } }),
  };
  const exportScope = {
    campaignId,
    stage,
    date,
    source,
    creditedChannel: responseChannel,
  };
  const canMutate = user.role === "ADMIN";
  const [
    today,
    sequences,
    total,
    stateCounts,
    exports,
    imports,
    smsPreview,
    batchDialerPreview,
  ] = await Promise.all([
    getTodayOperations({
      campaignId,
      stage,
      source,
      responseChannel,
      date,
    }),
    db.outreachSequence.findMany({
      where,
      orderBy: { lastEventAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        campaignContact: {
          include: {
            campaign: { select: { name: true } },
            contact: true,
            property: true,
            leadAttribution: true,
          },
        },
      },
    }),
    db.outreachSequence.count({ where }),
    db.outreachSequence.groupBy({
      by: ["currentState"],
      where,
      _count: { _all: true },
    }),
    db.outreachExport.findMany({
      where: campaignId ? { campaignId } : undefined,
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { createdBy: { select: { email: true } } },
    }),
    db.externalOutcomeImport.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    canMutate
      ? previewOutreachExport({
          ...exportScope,
          type: "SMS_ELIGIBILITY",
        })
      : Promise.resolve(null),
    canMutate
      ? previewOutreachExport({
          ...exportScope,
          type: "BATCH_DIALER",
        })
      : Promise.resolve(null),
  ]);
  const stateCount = (value: OutreachSequenceState) =>
    stateCounts.find((row) => row.currentState === value)?._count._all ?? 0;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-emerald-700">
            {today.date} · {today.timezone}
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            Outreach operations
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Durable RVM → external SMS → BatchDialer handoffs. This page does
            not send SMS or place cold calls.
          </p>
        </div>
      </div>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="RVM scheduled"
          value={today.rvmScheduled.toLocaleString()}
          detail={`${today.rvmProcessed.toLocaleString()} processed · ${today.rvmRemaining.toLocaleString()} remaining`}
          icon={Voicemail}
        />
        <MetricCard
          label="Live daily allowance"
          value={today.rvmAllowanceRemaining.toLocaleString()}
          detail={`${today.rvmAttempted.toLocaleString()} attempted · ${today.rvmSuccessful.toLocaleString()} successful`}
          icon={Clock3}
        />
        <MetricCard
          label="SMS awaiting export"
          value={today.smsAwaitingExport.toLocaleString()}
          detail={`${today.smsEligibleToday.toLocaleString()} became eligible on selected day`}
          icon={MessageSquareText}
        />
        <MetricCard
          label="Cold-call awaiting export"
          value={today.coldCallAwaitingExport.toLocaleString()}
          detail={`${today.coldCallEligibleToday.toLocaleString()} became eligible on selected day`}
          icon={PhoneCall}
        />
        <MetricCard
          label="Responses"
          value={today.callbacks.toLocaleString()}
          detail={`${today.qualifiedLeads.toLocaleString()} qualified · ${today.optOuts.toLocaleString()} opt-outs`}
          icon={CheckCircle2}
        />
      </section>

      <form className="card mt-5 grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-6">
        <select
          className="input"
          name="campaign"
          defaultValue={campaignId ?? ""}
        >
          <option value="">All campaigns</option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </select>
        <select className="input" name="stage" defaultValue={stage ?? ""}>
          <option value="">Active handoff stages</option>
          {Object.values(OutreachSequenceState).map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="date"
          name="date"
          defaultValue={date ?? ""}
          aria-label="Event date"
        />
        <select className="input" name="source" defaultValue={source ?? ""}>
          <option value="">All sources</option>
          {sourceRows.flatMap((row) =>
            row.source
              ? [
                  <option key={row.source} value={row.source}>
                    {row.source}
                  </option>,
                ]
              : [],
          )}
        </select>
        <select
          className="input"
          name="channel"
          defaultValue={responseChannel ?? ""}
        >
          <option value="">All response channels</option>
          {Object.values(AttributionChannel).map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <button className="btn-secondary" type="submit">
          <CalendarDays className="h-4 w-4" /> Filter
        </button>
      </form>

      <div className="mt-5 grid gap-3 sm:grid-cols-4">
        {[
          ["SMS eligible", stateCount("SMS_ELIGIBLE")],
          ["SMS exported", stateCount("SMS_EXPORTED")],
          ["SMS awaiting 48h", stateCount("SMS_SENT_EXTERNAL")],
          ["Cold-call eligible", stateCount("COLD_CALL_ELIGIBLE")],
        ].map(([label, value]) => (
          <div
            className="rounded-lg border border-slate-200 bg-white p-3"
            key={String(label)}
          >
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-bold">
              {Number(value).toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-5 space-y-5">
        {canMutate && smsPreview && batchDialerPreview ? (
          <>
            <OutreachExportControls
              scope={{
                ...exportScope,
                campaignName: campaignId
                  ? campaigns.find((campaign) => campaign.id === campaignId)
                      ?.name
                  : undefined,
              }}
              previews={{ sms: smsPreview, batchDialer: batchDialerPreview }}
            />
            <ExternalOutcomeImport />
          </>
        ) : (
          <section className="card p-5">
            <h2 className="font-bold">Read-only outreach access</h2>
            <p className="mt-1 text-sm text-slate-500">
              Analysts can review queues, exports, and imports. An admin must
              create handoff files or import external outcomes.
            </p>
          </section>
        )}
      </div>

      <section className="mt-7">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Sequence queue</h2>
            <p className="text-sm text-slate-500">
              {total.toLocaleString()} matching contacts
            </p>
          </div>
          <span className="text-xs text-slate-500">50 per page</span>
        </div>
        <div className="table-wrap overflow-x-auto">
          <table className="data-table min-w-[980px]">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Campaign / source</th>
                <th>Property</th>
                <th>Current stage</th>
                <th>Next / last event</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {sequences.map((sequence) => {
                const cc = sequence.campaignContact;
                return (
                  <tr key={sequence.id}>
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
                      <Link
                        className="font-medium hover:text-emerald-700"
                        href={`/campaigns/${cc.campaignId}`}
                      >
                        {cc.campaign.name}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {cc.property?.source || "No source"}
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
                      <StatusBadge status={sequence.currentState} />
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
                    <td>
                      <p className="text-xs">
                        {sequence.nextEligibleAt
                          ? `Due ${sequence.nextEligibleAt.toLocaleString()}`
                          : `Updated ${sequence.lastEventAt.toLocaleString()}`}
                      </p>
                    </td>
                    <td>
                      {canMutate && sequence.currentState === "SMS_EXPORTED" ? (
                        <MarkSmsSentButton sequenceId={sequence.id} />
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!sequences.length ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-slate-500">
                    No contacts match this queue.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pagination
          page={page}
          hasNext={page * pageSize < total}
          query={query}
        />
      </section>

      <section className="mt-7 grid gap-5 xl:grid-cols-2">
        <div>
          <h2 className="mb-3 text-lg font-bold">Recent exports</h2>
          <div className="card divide-y divide-slate-100 px-5">
            {exports.map((item) => (
              <div
                className="flex items-center justify-between gap-3 py-3"
                key={item.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {item.filename}
                  </p>
                  <p className="text-xs text-slate-500">
                    {item.itemCount.toLocaleString()} contacts ·{" "}
                    {item.createdAt.toLocaleString()} · {item.createdBy.email}
                  </p>
                </div>
                <a
                  className="text-sm font-semibold text-emerald-700"
                  href={`/api/outreach/exports/${item.id}/download`}
                >
                  Download
                </a>
              </div>
            ))}
            {!exports.length ? (
              <p className="py-6 text-sm text-slate-500">No exports yet.</p>
            ) : null}
          </div>
        </div>
        <div>
          <h2 className="mb-3 text-lg font-bold">Recent outcome imports</h2>
          <div className="card divide-y divide-slate-100 px-5">
            {imports.map((item) => (
              <div
                className="flex items-center justify-between py-3"
                key={item.id}
              >
                <div>
                  <p className="text-sm font-semibold">{item.fileName}</p>
                  <p className="text-xs text-slate-500">
                    {item.channel.replaceAll("_", " ")} · {item.acceptedCount}{" "}
                    accepted · {item.rejectedCount} rejected
                  </p>
                </div>
                <StatusBadge status={item.status} />
              </div>
            ))}
            {!imports.length ? (
              <p className="py-6 text-sm text-slate-500">
                No outcome imports yet.
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}

function Pagination({
  page,
  hasNext,
  query,
}: {
  page: number;
  hasNext: boolean;
  query: Record<string, string | undefined>;
}) {
  const href = (nextPage: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value && key !== "page") params.set(key, value);
    params.set("page", String(nextPage));
    return `/outreach?${params}`;
  };
  return (
    <div className="mt-4 flex justify-end gap-2">
      {page > 1 ? (
        <Link className="btn-secondary" href={href(page - 1)}>
          Previous
        </Link>
      ) : null}
      {hasNext ? (
        <Link className="btn-secondary" href={href(page + 1)}>
          Next
        </Link>
      ) : null}
    </div>
  );
}

function validIsoDate(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    return undefined;
  return value;
}
