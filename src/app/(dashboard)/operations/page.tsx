import {
  Prisma,
  type SmsInboundClassification,
  type SmsMessageStatus,
} from "@prisma/client";
import {
  AlertTriangle,
  Download,
  Filter,
  Inbox,
  MessageSquareReply,
  Send,
  Target,
} from "lucide-react";
import Link from "next/link";

import { MetricCard } from "@/components/metric-card";
import {
  BatchDialerExportControls,
  ColdCallOutcomeImport,
} from "@/components/outreach-actions";
import { StatusBadge } from "@/components/status-badge";
import {
  buildSmsCampaignInboundWhere,
  effectiveGlobalDailySmsCap,
  isQualifiedLeadOutcome,
  QUALIFIED_LEAD_OUTCOMES,
  qualifiedLeadCampaignContactWhere,
} from "@/lib/analytics";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import {
  campaignSpecificSourceFilter,
  previewOutreachExport,
} from "@/lib/outreach-exports";
import { SMS_INBOUND_CLASSIFICATIONS } from "@/lib/sms-conversations";
import { getAppSettings } from "@/lib/settings";
import {
  getLocalDayBounds,
  localDateStorageValue,
  zonedDateTimeToUtc,
} from "@/lib/time";

const PAGE_SIZE = 25;
const SMS_STATUSES = [
  "PENDING",
  "SCHEDULED",
  "DRY_RUN",
  "QUEUED",
  "SUBMITTING",
  "SUBMISSION_UNKNOWN",
  "ACCEPTED",
  "SENT",
  "DELIVERED",
  "UNDELIVERED",
  "FAILED",
  "REPLIED",
  "SUPPRESSED",
  "CANCELED",
] as const satisfies readonly SmsMessageStatus[];

interface OperationsQuery {
  page?: string;
  campaign?: string;
  date?: string;
  source?: string;
  state?: string;
  county?: string;
  smsStatus?: string;
  classification?: string;
  lead?: string;
  export?: string;
}

function clean(value: string | undefined, max = 200) {
  const result = value?.trim();
  return result && result.length <= max ? result : undefined;
}

function uuid(value: string | undefined) {
  const result = clean(value, 36);
  return result &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      result,
    )
    ? result
    : undefined;
}

function selectedDate(value: string | undefined) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function localDay(date: string | undefined, timezone: string) {
  if (!date) return getLocalDayBounds(new Date(), timezone);
  const [year, month, day] = date.split("-").map(Number);
  const valid =
    year > 2000 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  return getLocalDayBounds(
    valid
      ? zonedDateTimeToUtc({ year, month, day, hour: 12, minute: 0 }, timezone)
      : new Date(),
    timezone,
  );
}

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<OperationsQuery>;
}) {
  const query = await searchParams;
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const campaignId = uuid(query.campaign);
  const date = selectedDate(query.date);
  const source = clean(query.source);
  const state = clean(query.state, 100)?.toUpperCase();
  const county = clean(query.county);
  const smsStatus = SMS_STATUSES.includes(query.smsStatus as SmsMessageStatus)
    ? (query.smsStatus as SmsMessageStatus)
    : undefined;
  const classification = SMS_INBOUND_CLASSIFICATIONS.includes(
    query.classification as SmsInboundClassification,
  )
    ? (query.classification as SmsInboundClassification)
    : undefined;
  const lead = ["lead", "no_lead"].includes(query.lead ?? "")
    ? query.lead
    : undefined;
  const exportStatus = ["eligible", "exported", "not_exported"].includes(
    query.export ?? "",
  )
    ? query.export
    : undefined;

  const settings = await getAppSettings();
  const day = localDay(date, settings.operations_timezone);
  const conditions: Prisma.CampaignContactWhereInput[] = [
    { campaign: { is: { kind: "SMS" } } },
  ];
  if (campaignId) conditions.push({ campaignId });
  if (source) conditions.push(campaignSpecificSourceFilter(source));
  if (state || county)
    conditions.push({
      property: {
        is: {
          ...(state
            ? { state: { equals: state, mode: "insensitive" as const } }
            : {}),
          ...(county
            ? { county: { contains: county, mode: "insensitive" as const } }
            : {}),
        },
      },
    });
  if (date)
    conditions.push({
      outboundMessages: {
        some: { sentAt: { gte: day.start, lt: day.end } },
      },
    });
  if (smsStatus)
    conditions.push({ outboundMessages: { some: { status: smsStatus } } });
  if (classification)
    conditions.push({ inboundMessages: { some: { classification } } });
  if (lead) conditions.push(qualifiedLeadCampaignContactWhere(lead === "lead"));
  if (exportStatus === "eligible")
    conditions.push({
      outreachSequence: { is: { currentState: "COLD_CALL_ELIGIBLE" } },
    });
  if (exportStatus === "exported")
    conditions.push({
      outreachSequence: {
        is: { exportClaims: { some: { type: "BATCH_DIALER" } } },
      },
    });
  if (exportStatus === "not_exported")
    conditions.push({
      outreachSequence: {
        is: { exportClaims: { none: { type: "BATCH_DIALER" } } },
      },
    });
  const where: Prisma.CampaignContactWhereInput = { AND: conditions };

  const env = getEnv();
  const [
    rows,
    total,
    campaigns,
    states,
    counties,
    usage,
    sentToday,
    deliveredToday,
    repliesToday,
    interestedToday,
    qualifiedToday,
    optOutsToday,
    coldCallEligibleToday,
    awaitingExport,
    exportedToday,
    unclassifiedReplies,
    twilioFailureBreakdown,
    exportPreview,
    exports,
  ] = await Promise.all([
    db.campaignContact.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        campaign: { select: { id: true, name: true, sourceName: true } },
        contact: true,
        property: true,
        outboundMessages: {
          orderBy: { sequenceNumber: "desc" },
          take: 1,
          include: {
            attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
          },
        },
        inboundMessages: { orderBy: { receivedAt: "desc" }, take: 1 },
        outreachSequence: true,
        leadAttribution: true,
      },
    }),
    db.campaignContact.count({ where }),
    db.campaign.findMany({
      where: { kind: "SMS" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.property.findMany({
      where: { state: { not: null } },
      distinct: ["state"],
      orderBy: { state: "asc" },
      select: { state: true },
    }),
    db.property.findMany({
      where: {
        county: { not: null },
        ...(state
          ? { state: { equals: state, mode: "insensitive" as const } }
          : {}),
      },
      distinct: ["county"],
      orderBy: { county: "asc" },
      select: { county: true },
    }),
    db.smsDailyUsage.findUnique({
      where: {
        localDate_timezone: {
          localDate: localDateStorageValue(
            day.start,
            settings.operations_timezone,
          ),
          timezone: settings.operations_timezone,
        },
      },
    }),
    db.smsOutboundMessage.count({
      where: {
        sentAt: { gte: day.start, lt: day.end },
        campaignContact: { campaign: { kind: "SMS" } },
      },
    }),
    db.smsOutboundMessage.count({
      where: {
        deliveredAt: { gte: day.start, lt: day.end },
        campaignContact: { campaign: { kind: "SMS" } },
      },
    }),
    db.smsInboundMessage.count({
      where: buildSmsCampaignInboundWhere({
        receivedAt: { gte: day.start, lt: day.end },
      }),
    }),
    db.smsInboundMessage.count({
      where: buildSmsCampaignInboundWhere({
        receivedAt: { gte: day.start, lt: day.end },
        classification: {
          in: ["INTERESTED", "MAYBE", "FOLLOW_UP", "QUALIFIED_LEAD"],
        },
      }),
    }),
    db.leadAttribution.count({
      where: {
        attributedAt: { gte: day.start, lt: day.end },
        campaign: { kind: "SMS" },
        qualifyingOutcome: { in: QUALIFIED_LEAD_OUTCOMES },
      },
    }),
    db.smsInboundMessage.count({
      where: buildSmsCampaignInboundWhere({
        receivedAt: { gte: day.start, lt: day.end },
        OR: [{ isOptOut: true }, { classification: "OPT_OUT" }],
      }),
    }),
    db.outreachEvent.count({
      where: {
        type: "COLD_CALL_ELIGIBLE",
        occurredAt: { gte: day.start, lt: day.end },
        sequence: { campaignContact: { campaign: { kind: "SMS" } } },
      },
    }),
    db.outreachSequence.count({
      where: {
        currentState: "COLD_CALL_ELIGIBLE",
        campaignContact: { campaign: { kind: "SMS" } },
      },
    }),
    db.outreachExport.aggregate({
      where: {
        type: "BATCH_DIALER",
        createdAt: { gte: day.start, lt: day.end },
        items: {
          some: {
            sequence: { campaignContact: { campaign: { kind: "SMS" } } },
          },
        },
      },
      _sum: { itemCount: true },
    }),
    db.smsInboundMessage.count({
      where: { classification: { in: ["UNCLASSIFIED", "NEEDS_REVIEW"] } },
    }),
    db.smsOutboundMessage.groupBy({
      by: ["errorCode"],
      where: {
        providerKey: "twilio",
        status: { in: ["UNDELIVERED", "FAILED"] },
        errorCode: { not: null },
      },
      _count: { _all: true },
      orderBy: { _count: { errorCode: "desc" } },
      take: 10,
    }),
    previewOutreachExport({
      type: "BATCH_DIALER",
      campaignId,
      date,
      source,
      state,
      county,
    }),
    db.outreachExport.findMany({
      where: {
        type: "BATCH_DIALER",
        items: {
          some: {
            sequence: { campaignContact: { campaign: { kind: "SMS" } } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        campaign: { select: { name: true } },
        createdBy: { select: { email: true } },
      },
    }),
  ]);

  const attemptedToday = usage?.attemptedCount ?? 0;
  const effectiveDailyCap = effectiveGlobalDailySmsCap(
    settings.daily_sms_cap,
    env.MAX_LIVE_DAILY_SMS_LIMIT,
  );
  const remainingToday = Math.max(0, effectiveDailyCap - attemptedToday);
  const selectedCampaignName = campaigns.find(
    (item) => item.id === campaignId,
  )?.name;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-emerald-700">
            Today / operations
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">
            SMS operations
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {day.key} in {settings.operations_timezone}. The effective live-send
            safety cap is {effectiveDailyCap.toLocaleString()} SMS attempts per
            business day.
          </p>
        </div>
        <Link className="btn-secondary" href="/inbox">
          <Inbox className="h-4 w-4" /> Review{" "}
          {unclassifiedReplies.toLocaleString()} unreviewed
        </Link>
      </div>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Live SMS remaining"
          value={
            env.SMS_LIVE_SENDS_ENABLED
              ? remainingToday.toLocaleString()
              : "Disabled"
          }
          detail={`${attemptedToday.toLocaleString()} reserved · ${remainingToday.toLocaleString()} remaining under ${effectiveDailyCap.toLocaleString()}/day cap`}
          icon={Send}
        />
        <MetricCard
          label="Sent today"
          value={sentToday.toLocaleString()}
          detail={`${deliveredToday.toLocaleString()} delivered`}
          icon={Send}
        />
        <MetricCard
          label="Replies today"
          value={repliesToday.toLocaleString()}
          detail={`${interestedToday.toLocaleString()} interested · ${optOutsToday.toLocaleString()} opt-outs`}
          icon={MessageSquareReply}
        />
        <MetricCard
          label="Qualified today"
          value={qualifiedToday.toLocaleString()}
          detail={`${coldCallEligibleToday.toLocaleString()} became call-eligible`}
          icon={Target}
        />
      </section>

      <div className="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
        Awaiting BatchDialer export:{" "}
        <strong>{awaitingExport.toLocaleString()}</strong>
        {" · "}exported today:{" "}
        <strong>{(exportedToday._sum.itemCount ?? 0).toLocaleString()}</strong>
        {" · "}live SMS:{" "}
        <strong>{env.SMS_LIVE_SENDS_ENABLED ? "enabled" : "disabled"}</strong>
        {" · "}configured target / environment ceiling:{" "}
        <strong>
          {settings.daily_sms_cap.toLocaleString()} /{" "}
          {env.MAX_LIVE_DAILY_SMS_LIMIT.toLocaleString()} per day
        </strong>
      </div>

      <form className="card mt-6 grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        <select
          className="input"
          name="campaign"
          defaultValue={campaignId ?? ""}
          aria-label="Campaign"
        >
          <option value="">All campaigns</option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          name="date"
          type="date"
          defaultValue={date ?? ""}
          aria-label="Date"
        />
        <input
          className="input"
          name="source"
          defaultValue={source ?? ""}
          placeholder="Source / list"
          aria-label="Source or list"
        />
        <select
          className="input"
          name="state"
          defaultValue={state ?? ""}
          aria-label="State"
        >
          <option value="">All states</option>
          {states.flatMap((item) =>
            item.state
              ? [
                  <option key={item.state} value={item.state.toUpperCase()}>
                    {item.state.toUpperCase()}
                  </option>,
                ]
              : [],
          )}
        </select>
        <select
          className="input"
          name="county"
          defaultValue={county ?? ""}
          aria-label="County"
        >
          <option value="">All counties</option>
          {counties.flatMap((item) =>
            item.county
              ? [
                  <option key={item.county} value={item.county}>
                    {item.county}
                  </option>,
                ]
              : [],
          )}
        </select>
        <select
          className="input"
          name="smsStatus"
          defaultValue={smsStatus ?? ""}
          aria-label="SMS status"
        >
          <option value="">All SMS statuses</option>
          {SMS_STATUSES.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <select
          className="input"
          name="classification"
          defaultValue={classification ?? ""}
          aria-label="Reply classification"
        >
          <option value="">All reply classifications</option>
          {SMS_INBOUND_CLASSIFICATIONS.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <select
          className="input"
          name="lead"
          defaultValue={lead ?? ""}
          aria-label="Lead status"
        >
          <option value="">Any lead status</option>
          <option value="lead">Qualified lead</option>
          <option value="no_lead">Not a lead</option>
        </select>
        <select
          className="input"
          name="export"
          defaultValue={exportStatus ?? ""}
          aria-label="BatchDialer export status"
        >
          <option value="">Any export status</option>
          <option value="eligible">Awaiting export</option>
          <option value="exported">Exported</option>
          <option value="not_exported">Never exported</option>
        </select>
        <button className="btn-secondary" type="submit">
          <Filter className="h-4 w-4" /> Apply filters
        </button>
      </form>

      <section className="card mt-6 p-5">
        <h2 className="flex items-center gap-2 font-bold">
          <AlertTriangle className="h-4 w-4 text-amber-600" /> Twilio failure
          breakdown
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          Provider codes are retained verbatim. Use Twilio&apos;s current error
          reference rather than assuming a permanent meaning in Stonegate.
        </p>
        {twilioFailureBreakdown.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {twilioFailureBreakdown.map((item) => (
              <a
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900"
                href={`https://www.twilio.com/docs/api/errors/${encodeURIComponent(item.errorCode ?? "")}`}
                key={item.errorCode}
                rel="noreferrer"
                target="_blank"
              >
                {item.errorCode}: {item._count._all.toLocaleString()}
              </a>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-slate-500">
            No Twilio failed or undelivered messages with an error code.
          </p>
        )}
      </section>

      <section className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-bold">Contact operations</h2>
            <p className="mt-1 text-sm text-slate-500">
              {total.toLocaleString()} matching campaign contacts ·
              server-paginated
            </p>
          </div>
          <span className="text-xs text-slate-500">{PAGE_SIZE} per page</span>
        </div>
        <div className="table-wrap overflow-x-auto">
          <table className="data-table min-w-[1000px]">
            <thead>
              <tr>
                <th>Owner / phone</th>
                <th>Property / source</th>
                <th>Campaign</th>
                <th>SMS</th>
                <th>Reply</th>
                <th>Qualified lead</th>
                <th>BatchDialer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const message = row.outboundMessages[0];
                const reply = row.inboundMessages[0];
                const qualifiedLead = isQualifiedLeadOutcome(
                  row.leadAttribution?.qualifyingOutcome,
                );
                return (
                  <tr key={row.id}>
                    <td>
                      <p className="font-semibold">
                        {row.contact.ownerName ||
                          row.contact.firstName ||
                          "Unnamed"}
                      </p>
                      <p className="text-xs text-slate-500">
                        {row.contact.normalizedPhone}
                      </p>
                    </td>
                    <td>
                      <p>{row.property?.propertyAddress || "—"}</p>
                      <p className="text-xs text-slate-500">
                        {[
                          row.property?.city,
                          row.property?.state,
                          row.property?.county,
                        ]
                          .filter(Boolean)
                          .join(", ") ||
                          row.campaign.sourceName ||
                          "—"}
                      </p>
                    </td>
                    <td>
                      <Link
                        className="font-semibold text-emerald-700"
                        href={`/campaigns/${row.campaign.id}`}
                      >
                        {row.campaign.name}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {row.campaign.sourceName || "No source"}
                      </p>
                    </td>
                    <td>
                      <StatusBadge status={message?.status ?? row.status} />
                      {message?.errorCode ? (
                        <p className="mt-1 text-[11px] font-semibold text-rose-700">
                          Error {message.errorCode}
                        </p>
                      ) : null}
                      {message?.providerMessageId ? (
                        <p
                          className="mt-1 max-w-40 truncate font-mono text-[10px] text-slate-500"
                          title={message.providerMessageId}
                        >
                          {message.providerMessageId}
                        </p>
                      ) : null}
                      {message?.attempts[0] ? (
                        <p className="mt-1 text-[10px] text-slate-500">
                          Attempt {message.attempts[0].attemptNumber} ·{" "}
                          {message.failedAt?.toLocaleString() ??
                            message.sentAt?.toLocaleString() ??
                            message.attempts[0].startedAt.toLocaleString()}
                        </p>
                      ) : message?.sentAt ? (
                        <p className="mt-1 text-[11px] text-slate-500">
                          {message.sentAt.toLocaleString()}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      {reply ? (
                        <>
                          <StatusBadge status={reply.classification} />
                          <p className="mt-1 max-w-44 truncate text-xs text-slate-500">
                            {reply.body}
                          </p>
                        </>
                      ) : (
                        <span className="text-slate-400">No reply</span>
                      )}
                    </td>
                    <td>
                      {qualifiedLead && row.leadAttribution ? (
                        <StatusBadge
                          status={`${row.leadAttribution.creditedChannel}_LEAD`}
                        />
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge
                        status={
                          row.outreachSequence?.currentState ?? "NOT_ENROLLED"
                        }
                      />
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    No contacts match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Pagination page={page} total={total} query={query} />
      </section>

      <div className="mt-7 space-y-5">
        <BatchDialerExportControls
          scope={{
            campaignId,
            campaignName: selectedCampaignName,
            date,
            source,
            state,
            county,
          }}
          preview={exportPreview}
        />
        <ColdCallOutcomeImport />
      </div>

      <section className="mt-7">
        <h2 className="mb-3 flex items-center gap-2 font-bold">
          <Download className="h-4 w-4 text-emerald-700" /> Recent BatchDialer
          exports
        </h2>
        <div className="table-wrap overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th>Created</th>
                <th>Campaign</th>
                <th>Rows</th>
                <th>Created by</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {exports.map((item) => (
                <tr key={item.id}>
                  <td>{item.createdAt.toLocaleString()}</td>
                  <td>{item.campaign?.name ?? "Multiple campaigns"}</td>
                  <td>{item.itemCount.toLocaleString()}</td>
                  <td>{item.createdBy.email}</td>
                  <td>
                    <Link
                      className="font-semibold text-emerald-700"
                      href={`/api/outreach/exports/${item.id}/download`}
                    >
                      {item.filename}
                    </Link>
                    {item.intentionalRepeat ? (
                      <p className="text-[11px] text-amber-700">
                        Intentional repeat: {item.repeatReason}
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!exports.length ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500">
                    No BatchDialer exports yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Pagination({
  page,
  total,
  query,
}: {
  page: number;
  total: number;
  query: OperationsQuery;
}) {
  const href = (nextPage: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value && key !== "page") params.set(key, value);
    params.set("page", String(nextPage));
    return `/operations?${params}`;
  };
  return (
    <div className="mt-4 flex justify-end gap-2">
      {page > 1 ? (
        <Link className="btn-secondary" href={href(page - 1)}>
          Previous
        </Link>
      ) : null}
      {page * PAGE_SIZE < total ? (
        <Link className="btn-secondary" href={href(page + 1)}>
          Next
        </Link>
      ) : null}
    </div>
  );
}
