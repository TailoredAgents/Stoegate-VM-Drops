import { Prisma, type UserRole } from "@prisma/client";
import { createCsv } from "@/lib/csv";
import { db } from "@/lib/db";
import { normalizeUSPhone } from "@/lib/phone";
import { getAppSettings } from "@/lib/settings";
import { getLocalDayBounds, zonedDateTimeToUtc } from "@/lib/time";

export const MAX_OUTREACH_EXPORT_ROWS = 25_000;

const candidateInclude = Prisma.validator<Prisma.OutreachSequenceInclude>()({
  campaignContact: {
    include: {
      campaign: {
        select: { id: true, name: true, sourceName: true },
      },
      contact: true,
      property: true,
      importRow: { select: { mappedData: true, rawData: true } },
      outboundMessages: {
        where: { sequenceNumber: 1 },
        select: {
          status: true,
          sentAt: true,
          deliveredAt: true,
          templateVersion: {
            select: {
              version: true,
              template: { select: { name: true } },
            },
          },
        },
        take: 1,
      },
    },
  },
});

type ExportCandidate = Prisma.OutreachSequenceGetPayload<{
  include: typeof candidateInclude;
}>;

export const BATCH_DIALER_HEADERS = [
  "First Name",
  "Last Name",
  "Owner Name",
  "Phone",
  "Property Address",
  "Street Name",
  "City",
  "State",
  "ZIP",
  "County",
  "Acreage",
  "Property Type",
  "Source",
  "Campaign",
  "SMS Status",
  "SMS Sent Timestamp",
  "SMS Delivered Timestamp",
  "SMS Template",
  "Stonegate Contact ID",
  "Stonegate Campaign Contact ID",
  "Source External ID",
  "Stonegate Export ID",
] as const;

function stringRecord(value: Prisma.JsonValue | null | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {} as Record<string, string>;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      item == null
        ? ""
        : typeof item === "string"
          ? item
          : JSON.stringify(item),
    ]),
  );
}

function candidateRow(candidate: ExportCandidate, exportId: string) {
  const cc = candidate.campaignContact;
  const mapped = stringRecord(cc.importRow?.mappedData);
  const raw = stringRecord(cc.importRow?.rawData);
  const message = cc.outboundMessages[0];
  const base: Record<string, string> = {
    "First Name": mapped.first_name || cc.contact.firstName || "",
    "Last Name": mapped.last_name || cc.contact.lastName || "",
    "Owner Name": mapped.owner_name || cc.contact.ownerName || "",
    Phone: cc.contact.normalizedPhone,
    "Property Address":
      mapped.property_address || cc.property?.propertyAddress || "",
    "Street Name": mapped.street_name || cc.property?.streetName || "",
    City: mapped.city || cc.property?.city || "",
    State: mapped.state || cc.property?.state || "",
    ZIP: mapped.postal_code || cc.property?.postalCode || "",
    County: mapped.county || cc.property?.county || "",
    Acreage: mapped.acreage || cc.property?.acreage?.toString() || "",
    "Property Type": mapped.property_type || cc.property?.propertyType || "",
    Source:
      mapped.source ||
      cc.campaign.sourceName ||
      cc.property?.source ||
      cc.contact.source ||
      "",
    Campaign: cc.campaign.name,
    "SMS Status": message?.status ?? "",
    "SMS Sent Timestamp":
      message?.sentAt?.toISOString() ??
      candidate.smsSentAt?.toISOString() ??
      "",
    "SMS Delivered Timestamp": message?.deliveredAt?.toISOString() ?? "",
    "SMS Template": message
      ? message.templateVersion.template.name +
        " v" +
        message.templateVersion.version
      : "",
    "Stonegate Contact ID": cc.contactId,
    "Stonegate Campaign Contact ID": cc.id,
    "Source External ID":
      mapped.external_id ||
      cc.property?.externalId ||
      cc.contact.externalId ||
      "",
    "Stonegate Export ID": exportId,
  };
  for (const [header, value] of Object.entries(raw))
    base["Original - " + header] = value;
  return base;
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "all-campaigns"
  );
}

export interface OutreachExportFilters {
  campaignId?: string;
  date?: string;
  source?: string;
  state?: string;
  county?: string;
}

export interface CreateOutreachExportInput extends OutreachExportFilters {
  type: "BATCH_DIALER";
  idempotencyKey: string;
  intentionalRepeat?: boolean;
  repeatReason?: string;
  confirmation?: string;
  user: { id: string; role: UserRole };
}

export interface OutreachExportPreview {
  newCount: number;
  includingRepeatCount: number;
  maxRows: number;
  newExceedsLimit: boolean;
  repeatExceedsLimit: boolean;
}

export function exportFilterSnapshot(input: OutreachExportFilters) {
  return {
    campaignId: input.campaignId ?? null,
    date: input.date ?? null,
    source: input.source?.trim() || null,
    state: input.state?.trim().toUpperCase() || null,
    county: input.county?.trim() || null,
  };
}

function jsonRecord(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function exportRequestMatchesExisting(
  existing: {
    type: string;
    campaignId: string | null;
    createdByUserId: string;
    intentionalRepeat: boolean;
    repeatReason: string | null;
    filtersSnapshot: Prisma.JsonValue | null;
  },
  input: CreateOutreachExportInput,
) {
  const stored = jsonRecord(existing.filtersSnapshot);
  const requested = exportFilterSnapshot(input);
  return (
    existing.type === "BATCH_DIALER" &&
    existing.campaignId === requested.campaignId &&
    existing.createdByUserId === input.user.id &&
    existing.intentionalRepeat === (input.intentionalRepeat === true) &&
    (existing.repeatReason ?? null) ===
      (input.intentionalRepeat ? input.repeatReason?.trim() || null : null) &&
    (stored.campaignId ?? null) === requested.campaignId &&
    (stored.date ?? null) === requested.date &&
    (stored.source ?? null) === requested.source &&
    (stored.state ?? null) === requested.state &&
    (stored.county ?? null) === requested.county
  );
}

async function dateRange(date: string | undefined) {
  if (!date) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("Export date is invalid");
  const [year, month, day] = date.split("-").map(Number);
  if (
    !year ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  )
    throw new Error("Export date is invalid");
  const { operations_timezone: timeZone } = await getAppSettings();
  return getLocalDayBounds(
    zonedDateTimeToUtc({ year, month, day, hour: 12, minute: 0 }, timeZone),
    timeZone,
  );
}

export function campaignSpecificSourceFilter(
  source: string,
): Prisma.CampaignContactWhereInput {
  const match = { contains: source, mode: "insensitive" as const };
  return {
    OR: [
      { campaign: { is: { sourceName: match } } },
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
      { property: { is: { source: match } } },
      { contact: { is: { source: match } } },
    ],
  };
}

async function candidateWhere(
  input: OutreachExportFilters & { intentionalRepeat: boolean },
): Promise<Prisma.OutreachSequenceWhereInput> {
  const range = await dateRange(input.date);
  const campaignContactFilters: Prisma.CampaignContactWhereInput[] = [];
  if (input.source?.trim())
    campaignContactFilters.push(
      campaignSpecificSourceFilter(input.source.trim()),
    );
  if (input.state?.trim())
    campaignContactFilters.push({
      property: {
        is: {
          state: {
            equals: input.state.trim().toUpperCase(),
            mode: "insensitive",
          },
        },
      },
    });
  if (input.county?.trim())
    campaignContactFilters.push({
      property: {
        is: {
          county: {
            contains: input.county.trim(),
            mode: "insensitive",
          },
        },
      },
    });
  return {
    currentState: input.intentionalRepeat
      ? { in: ["COLD_CALL_ELIGIBLE", "COLD_CALL_EXPORTED"] }
      : "COLD_CALL_ELIGIBLE",
    terminalAt: null,
    smsSentAt: { not: null },
    smsRespondedAt: null,
    ...(range
      ? { coldCallEligibleAt: { gte: range.start, lt: range.end } }
      : {}),
    ...(input.intentionalRepeat
      ? {}
      : { exportClaims: { none: { type: "BATCH_DIALER" } } }),
    campaignContact: {
      campaign: {
        is: {
          kind: "SMS",
          ...(input.campaignId ? { id: input.campaignId } : {}),
        },
      },
      leadAttribution: { is: null },
      inboundMessages: { none: {} },
      contact: {
        is: {
          suppressions: { none: {} },
          campaigns: { none: { leadAttribution: { isNot: null } } },
        },
      },
      outboundMessages: { some: { sentAt: { not: null } } },
      ...(campaignContactFilters.length ? { AND: campaignContactFilters } : {}),
    },
  };
}

export async function previewOutreachExport(
  input: OutreachExportFilters & { type: "BATCH_DIALER" },
): Promise<OutreachExportPreview> {
  const [newCount, includingRepeatCount] = await Promise.all([
    candidateWhere({ ...input, intentionalRepeat: false }).then((where) =>
      db.outreachSequence.count({ where }),
    ),
    candidateWhere({ ...input, intentionalRepeat: true }).then((where) =>
      db.outreachSequence.count({ where }),
    ),
  ]);
  return {
    newCount,
    includingRepeatCount,
    maxRows: MAX_OUTREACH_EXPORT_ROWS,
    newExceedsLimit: newCount > MAX_OUTREACH_EXPORT_ROWS,
    repeatExceedsLimit: includingRepeatCount > MAX_OUTREACH_EXPORT_ROWS,
  };
}

function assertIdempotentMatch(
  existing: Prisma.OutreachExportGetPayload<Record<string, never>>,
  input: CreateOutreachExportInput,
) {
  if (!exportRequestMatchesExisting(existing, input))
    throw new Error(
      "Idempotency key was already used for a different export request",
    );
  return existing;
}

async function createOnce(input: CreateOutreachExportInput) {
  const existing = await db.outreachExport.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (existing) return assertIdempotentMatch(existing, input);
  const intentionalRepeat = input.intentionalRepeat === true;
  if (intentionalRepeat) {
    if (input.user.role !== "ADMIN")
      throw new Error("Only an admin can intentionally re-export contacts");
    if (input.confirmation !== "RE-EXPORT")
      throw new Error("Type RE-EXPORT to confirm an intentional repeat export");
    if (!input.repeatReason?.trim())
      throw new Error("A repeat-export reason is required");
  }
  const where = await candidateWhere({ ...input, intentionalRepeat });
  return db.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1))::text",
        "batch-export:" + input.idempotencyKey,
      );
      const concurrent = await tx.outreachExport.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (concurrent) return assertIdempotentMatch(concurrent, input);

      const candidates = await tx.outreachSequence.findMany({
        where,
        include: candidateInclude,
        orderBy: { coldCallEligibleAt: "asc" },
        take: MAX_OUTREACH_EXPORT_ROWS + 1,
      });
      if (candidates.length > MAX_OUTREACH_EXPORT_ROWS)
        throw new Error(
          "This export matches more than " +
            MAX_OUTREACH_EXPORT_ROWS.toLocaleString() +
            " contacts; narrow the filters before exporting",
        );
      const phones = [
        ...new Set(
          candidates.map((row) => row.campaignContact.contact.normalizedPhone),
        ),
      ];
      const campaignIds = [
        ...new Set(candidates.map((row) => row.campaignContact.campaignId)),
      ];
      const [globalSuppressions, campaignSuppressions] = await Promise.all([
        tx.suppressionEntry.findMany({
          where: { normalizedPhone: { in: phones } },
          select: { normalizedPhone: true },
        }),
        tx.campaignSuppression.findMany({
          where: {
            campaignId: { in: campaignIds },
            normalizedPhone: { in: phones },
          },
          select: { campaignId: true, normalizedPhone: true },
        }),
      ]);
      const globallyBlocked = new Set(
        globalSuppressions.map((row) => row.normalizedPhone),
      );
      const campaignBlocked = new Set(
        campaignSuppressions.map(
          (row) => row.campaignId + "|" + row.normalizedPhone,
        ),
      );
      const valid = candidates.filter((candidate) => {
        const phone = candidate.campaignContact.contact.normalizedPhone;
        return (
          !globallyBlocked.has(phone) &&
          !campaignBlocked.has(
            candidate.campaignContact.campaignId + "|" + phone,
          ) &&
          normalizeUSPhone(phone) === phone
        );
      });
      if (!valid.length)
        throw new Error("No eligible contacts match this export");

      const campaignLabel = input.campaignId
        ? (valid[0]?.campaignContact.campaign.name ?? "campaign")
        : "all-campaigns";
      const draft = await tx.outreachExport.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          type: "BATCH_DIALER",
          campaignId: input.campaignId,
          createdByUserId: input.user.id,
          filename: "pending.csv",
          intentionalRepeat,
          repeatReason: intentionalRepeat
            ? input.repeatReason?.trim()
            : undefined,
          filtersSnapshot: exportFilterSnapshot(input),
        },
      });
      // Even an intentional mixed export may contain contacts that have never
      // been handed off before. Claim those rows now so a later ordinary
      // export cannot accidentally include them again; existing claims remain
      // anchored to their original export.
      await tx.outreachExportClaim.createMany({
        data: valid.map((candidate) => ({
          sequenceId: candidate.id,
          type: "BATCH_DIALER",
          firstExportId: draft.id,
        })),
        skipDuplicates: true,
      });
      const claimedIds = intentionalRepeat
        ? new Set(valid.map((candidate) => candidate.id))
        : new Set(
            (
              await tx.outreachExportClaim.findMany({
                where: {
                  firstExportId: draft.id,
                  type: "BATCH_DIALER",
                },
                select: { sequenceId: true },
              })
            ).map((claim) => claim.sequenceId),
          );
      const selected = valid.filter((candidate) =>
        claimedIds.has(candidate.id),
      );
      if (!selected.length)
        throw new Error("Every matching contact was already exported");
      const priorCounts = intentionalRepeat
        ? await tx.outreachExportItem.groupBy({
            by: ["sequenceId"],
            where: {
              sequenceId: { in: selected.map((row) => row.id) },
              export: { type: "BATCH_DIALER" },
            },
            _count: { _all: true },
          })
        : [];
      const countBySequence = new Map(
        priorCounts.map((row) => [row.sequenceId, row._count._all]),
      );
      await tx.outreachExportItem.createMany({
        data: selected.map((candidate) => ({
          exportId: draft.id,
          sequenceId: candidate.id,
          campaignContactId: candidate.campaignContactId,
          occurrence: (countBySequence.get(candidate.id) ?? 0) + 1,
          rowSnapshot: candidateRow(
            candidate,
            draft.id,
          ) as Prisma.InputJsonValue,
        })),
      });
      const now = new Date();
      await tx.outreachEvent.createMany({
        data: selected.map((candidate) => ({
          sequenceId: candidate.id,
          type: "COLD_CALL_EXPORTED" as const,
          channel: "COLD_CALL" as const,
          resultingState: "COLD_CALL_EXPORTED" as const,
          occurredAt: now,
          source: "batchdialer_export",
          idempotencyKey:
            "batch-export:" + draft.id + ":sequence:" + candidate.id,
          actorUserId: input.user.id,
          metadata: { intentionalRepeat },
        })),
      });
      await tx.outreachSequence.updateMany({
        where: { id: { in: selected.map((candidate) => candidate.id) } },
        data: {
          currentState: "COLD_CALL_EXPORTED",
          lastEventAt: now,
          version: { increment: 1 },
        },
      });
      await tx.outreachSequence.updateMany({
        where: {
          id: { in: selected.map((candidate) => candidate.id) },
          coldCallExportedAt: null,
        },
        data: { coldCallExportedAt: now },
      });
      const filename =
        "stonegate-batchdialer-" +
        slug(campaignLabel) +
        "-" +
        now.toISOString().slice(0, 10) +
        "-" +
        draft.id.slice(0, 8) +
        ".csv";
      return tx.outreachExport.update({
        where: { id: draft.id },
        data: { filename, itemCount: selected.length },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 60_000,
    },
  );
}

export async function createOutreachExport(input: CreateOutreachExportInput) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await createOnce(input);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const existing = await db.outreachExport.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) return assertIdempotentMatch(existing, input);
      }
      if (
        attempt < 3 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      )
        continue;
      throw error;
    }
  }
  throw new Error("Could not create BatchDialer export");
}

export async function getOutreachExportCsv(exportId: string) {
  const result = await db.outreachExport.findUnique({
    where: { id: exportId },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!result || result.type !== "BATCH_DIALER") return null;
  const rows = result.items.map(
    (item) => item.rowSnapshot as Record<string, string>,
  );
  const originalHeaders = [
    ...new Set(
      rows.flatMap((row) =>
        Object.keys(row).filter((header) => header.startsWith("Original - ")),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return {
    filename: result.filename,
    csv: createCsv(
      [...BATCH_DIALER_HEADERS, ...originalHeaders],
      rows,
      new Set(["Phone"]),
    ),
  };
}
