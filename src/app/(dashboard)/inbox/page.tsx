import type { Metadata } from "next";
import type { Prisma, SmsInboundClassification } from "@prisma/client";
import Link from "next/link";
import { Filter, Inbox } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { SMS_INBOUND_CLASSIFICATIONS } from "@/lib/sms-conversations";
import { classifySmsInboundMessageAction } from "./actions";

export const metadata: Metadata = { title: "SMS inbox" };

const pageSize = 25;
const replyPreviewLimit = 8;

interface InboxQuery {
  page?: string;
  classification?: string;
  campaign?: string;
  state?: string;
  county?: string;
}

function selectedClassification(value: string | undefined) {
  return SMS_INBOUND_CLASSIFICATIONS.includes(value as SmsInboundClassification)
    ? (value as SmsInboundClassification)
    : undefined;
}

function selectedUuid(value: string | undefined) {
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

function selectedLocation(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length <= 120 ? normalized : undefined;
}

export default async function SmsInboxPage({
  searchParams,
}: {
  searchParams: Promise<InboxQuery>;
}) {
  await requireUser();
  const query = await searchParams;
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const classification = selectedClassification(query.classification);
  const campaignId = selectedUuid(query.campaign);
  const state = selectedLocation(query.state)?.toUpperCase();
  const county = selectedLocation(query.county);

  const propertyWhere: Prisma.PropertyWhereInput = {};
  if (state) propertyWhere.state = { equals: state, mode: "insensitive" };
  if (county) propertyWhere.county = { equals: county, mode: "insensitive" };

  const campaignContactWhere: Prisma.CampaignContactWhereInput = {};
  if (campaignId) campaignContactWhere.campaignId = campaignId;
  if (state || county) campaignContactWhere.property = { is: propertyWhere };

  const where: Prisma.SmsConversationWhereInput = {
    campaignContact: campaignContactWhere,
    inboundMessages: {
      some: classification ? { classification } : {},
    },
  };

  const [conversations, total, campaigns, states, counties] = await Promise.all(
    [
      db.smsConversation.findMany({
        where,
        orderBy: [
          { lastMessageAt: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          campaignContact: {
            include: {
              campaign: { select: { id: true, name: true } },
              contact: {
                include: {
                  suppressions: {
                    select: { id: true, reason: true, createdAt: true },
                  },
                },
              },
              property: true,
              outreachSequence: true,
              leadAttribution: true,
            },
          },
          outboundMessages: {
            orderBy: [{ sequenceNumber: "asc" }, { createdAt: "asc" }],
            take: 1,
          },
          inboundMessages: {
            ...(classification ? { where: { classification } } : {}),
            orderBy: { receivedAt: "desc" },
            take: replyPreviewLimit,
            include: {
              classifiedBy: { select: { email: true } },
            },
          },
          _count: {
            select: {
              inboundMessages: classification
                ? { where: { classification } }
                : true,
            },
          },
        },
      }),
      db.smsConversation.count({ where }),
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
    ],
  );

  const campaignSuppressions = conversations.length
    ? await db.campaignSuppression.findMany({
        where: {
          OR: conversations.map((conversation) => ({
            campaignId: conversation.campaignContact.campaignId,
            normalizedPhone:
              conversation.campaignContact.contact.normalizedPhone,
          })),
        },
        select: {
          campaignId: true,
          normalizedPhone: true,
          reason: true,
          createdAt: true,
        },
      })
    : [];
  const suppressionByCampaignAndPhone = new Map(
    campaignSuppressions.map((suppression) => [
      `${suppression.campaignId}:${suppression.normalizedPhone}`,
      suppression,
    ]),
  );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-emerald-700">
            Response operations
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">SMS inbox</h1>
          <p className="mt-1 text-sm text-slate-500">
            {total.toLocaleString()} conversation
            {total === 1 ? "" : "s"} with inbound replies. Any reply stops later
            campaign outreach; opt-outs and wrong numbers suppress the phone
            globally.
          </p>
        </div>
        <span className="text-xs font-semibold text-slate-500">
          {pageSize} conversations per page
        </span>
      </div>

      <form className="card mt-6 grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        <select
          className="input"
          name="classification"
          defaultValue={classification ?? ""}
          aria-label="Reply classification"
        >
          <option value="">All classifications</option>
          {SMS_INBOUND_CLASSIFICATIONS.map((value) => (
            <option key={value} value={value}>
              {value.replaceAll("_", " ")}
            </option>
          ))}
        </select>
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
        <select
          className="input"
          name="state"
          defaultValue={state ?? ""}
          aria-label="Property state"
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
          aria-label="Property county"
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
        <button className="btn-secondary" type="submit">
          <Filter className="h-4 w-4" /> Filter
        </button>
      </form>

      <section className="mt-6 space-y-4">
        {conversations.map((conversation) => {
          const campaignContact = conversation.campaignContact;
          const contact = campaignContact.contact;
          const property = campaignContact.property;
          const initialMessage = conversation.outboundMessages[0];
          const campaignSuppression = suppressionByCampaignAndPhone.get(
            `${campaignContact.campaignId}:${contact.normalizedPhone}`,
          );
          const owner =
            contact.ownerName ||
            [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
            "Unnamed owner";

          return (
            <article className="card overflow-hidden" key={conversation.id}>
              <div className="grid gap-4 border-b border-slate-100 p-5 lg:grid-cols-[minmax(190px,0.65fr)_minmax(250px,1fr)_minmax(220px,0.8fr)]">
                <div>
                  <p className="font-bold text-slate-950">{owner}</p>
                  <p className="mt-1 text-sm text-slate-600">
                    {contact.normalizedPhone}
                  </p>
                  <Link
                    className="mt-2 inline-block text-xs font-semibold text-emerald-700 hover:text-emerald-800"
                    href={`/campaigns/${campaignContact.campaignId}`}
                  >
                    {campaignContact.campaign.name}
                  </Link>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Property
                  </p>
                  <p className="mt-1 text-sm font-medium text-slate-800">
                    {property?.propertyAddress || "No property address"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {[property?.city, property?.state, property?.postalCode]
                      .filter(Boolean)
                      .join(", ") || "Location unavailable"}
                    {property?.county ? ` · ${property.county} County` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap content-start items-start gap-2 lg:justify-end">
                  <StatusBadge status={conversation.status} />
                  {campaignContact.outreachSequence ? (
                    <StatusBadge
                      status={campaignContact.outreachSequence.currentState}
                    />
                  ) : null}
                  {campaignContact.leadAttribution ? (
                    <span className="inline-flex rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-bold text-emerald-800">
                      {campaignContact.leadAttribution.creditedChannel} lead
                    </span>
                  ) : null}
                  {contact.suppressions.map((suppression) => (
                    <span
                      className="inline-flex rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-bold text-orange-700"
                      key={suppression.id}
                      title={`Global suppression since ${suppression.createdAt.toLocaleString()}`}
                    >
                      Global {suppression.reason.replaceAll("_", " ")}
                    </span>
                  ))}
                  {campaignSuppression ? (
                    <span
                      className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-bold text-amber-700"
                      title={`Campaign suppression since ${campaignSuppression.createdAt.toLocaleString()}`}
                    >
                      Campaign {campaignSuppression.reason.replaceAll("_", " ")}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-0 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.4fr)]">
                <div className="border-b border-slate-100 bg-slate-50/60 p-5 xl:border-r xl:border-b-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Initial message
                  </p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">
                    {initialMessage?.renderedBody ||
                      "Outbound message unavailable"}
                  </p>
                  <p className="mt-3 text-xs text-slate-500">
                    {initialMessage
                      ? `${initialMessage.status.replaceAll("_", " ")} · ${(
                          initialMessage.sentAt ??
                          initialMessage.acceptedAt ??
                          initialMessage.createdAt
                        ).toLocaleString()}`
                      : `Conversation opened ${conversation.openedAt.toLocaleString()}`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Latest activity:{" "}
                    {conversation.lastMessageAt?.toLocaleString() ?? "—"}
                  </p>
                </div>

                <div className="divide-y divide-slate-100">
                  {conversation.inboundMessages.map((message) => (
                    <div className="p-5" key={message.id}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-800">
                            {message.body || "(empty reply)"}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Received {message.receivedAt.toLocaleString()}
                            {message.classifiedBy
                              ? ` · classified by ${message.classifiedBy.email}`
                              : ""}
                          </p>
                        </div>
                        <StatusBadge status={message.classification} />
                      </div>
                      <form
                        action={classifySmsInboundMessageAction}
                        className="mt-3 flex flex-wrap gap-2"
                      >
                        <input
                          type="hidden"
                          name="messageId"
                          value={message.id}
                        />
                        <select
                          className="input min-w-48 flex-1"
                          name="classification"
                          defaultValue={message.classification}
                          aria-label={`Classify reply from ${owner}`}
                        >
                          {SMS_INBOUND_CLASSIFICATIONS.map((value) => (
                            <option key={value} value={value}>
                              {value.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                        <button className="btn-secondary" type="submit">
                          Save classification
                        </button>
                      </form>
                    </div>
                  ))}
                  {conversation._count.inboundMessages > replyPreviewLimit ? (
                    <p className="p-4 text-xs text-slate-500">
                      Showing the {replyPreviewLimit} newest of{" "}
                      {conversation._count.inboundMessages.toLocaleString()}{" "}
                      replies.
                    </p>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}

        {!conversations.length ? (
          <div className="card grid place-items-center gap-3 p-12 text-center">
            <Inbox className="h-8 w-8 text-slate-300" />
            <div>
              <p className="font-semibold text-slate-700">
                No conversations match these filters
              </p>
              <p className="mt-1 text-sm text-slate-500">
                New provider replies will appear here after they are matched to
                an outbound SMS.
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <Pagination page={page} total={total} query={query} />
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
  query: InboxQuery;
}) {
  const href = (nextPage: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value && key !== "page") params.set(key, value);
    params.set("page", String(nextPage));
    return `/inbox?${params}`;
  };

  return (
    <div className="mt-5 flex items-center justify-end gap-2">
      {page > 1 ? (
        <Link className="btn-secondary" href={href(page - 1)}>
          Previous
        </Link>
      ) : null}
      {page * pageSize < total ? (
        <Link className="btn-secondary" href={href(page + 1)}>
          Next
        </Link>
      ) : null}
    </div>
  );
}
