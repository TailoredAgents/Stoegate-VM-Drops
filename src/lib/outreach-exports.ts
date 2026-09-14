import {
  type AttributionChannel,
  type OutreachExportType,
  type OutreachSequenceState,
  Prisma,
  type UserRole,
} from "@prisma/client";
import { createCsv } from "@/lib/csv";
import { db } from "@/lib/db";
import { normalizeUSPhone } from "@/lib/phone";
import { getAppSettings } from "@/lib/settings";
import { getLocalDayBounds, zonedDateTimeToUtc } from "@/lib/time";

export const MAX_OUTREACH_EXPORT_ROWS = 25_000;

const candidateInclude = Prisma.validator<Prisma.OutreachSequenceInclude>()({
  campaignContact: {
    include: {
      campaign: { select: { id: true, name: true } },
      contact: true,
      property: true,
      importRow: { select: { mappedData: true, rawData: true } },
    },
  },
});

type ExportCandidate = Prisma.OutreachSequenceGetPayload<{
  include: typeof candidateInclude;
}>;

export const SMS_EXPORT_HEADERS = [
  "Stonegate Campaign Contact ID",
  "Stonegate Contact ID",
  "Phone",
  "First Name",
  "Last Name",
  "Owner Name",
  "Property Address",
  "City",
  "State",
  "ZIP",
  "Campaign",
  "Source",
  "RVM Sent Timestamp",
  "SMS Eligible Timestamp",
  "Stonegate Export ID",
] as const;

export const BATCH_DIALER_HEADERS = [
  "First Name",
  "Last Name",
  "Owner Name",
  "Phone",
  "Property Address",
  "City",
  "State",
  "ZIP",
  "County",
  "Property Type",
  "Source",
  "Campaign",
  "RVM Sent Timestamp",
  "SMS Sent Timestamp",
  "Stonegate Contact ID",
  "Stonegate Campaign Contact ID",
  "Street Name",
  "Acreage",
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

function candidateRow(
  candidate: ExportCandidate,
  exportId: string,
  type: OutreachExportType,
) {
  const cc = candidate.campaignContact;
  const mapped = stringRecord(cc.importRow?.mappedData);
  const raw = stringRecord(cc.importRow?.rawData);
  const base: Record<string, string> = {
    "First Name": mapped.first_name || cc.contact.firstName || "",
    "Last Name": mapped.last_name || cc.contact.lastName || "",
    "Owner Name": mapped.owner_name || cc.contact.ownerName || "",
    Phone: cc.contact.normalizedPhone,
    "Property Address":
      mapped.property_address || cc.property?.propertyAddress || "",
    City: mapped.city || cc.property?.city || "",
    State: mapped.state || cc.property?.state || "",
    ZIP: mapped.postal_code || cc.property?.postalCode || "",
    County: mapped.county || cc.property?.county || "",
    "Property Type": mapped.property_type || cc.property?.propertyType || "",
    Source: mapped.source || cc.property?.source || cc.contact.source || "",
    Campaign: cc.campaign.name,
    "RVM Sent Timestamp": candidate.rvmAttemptedAt?.toISOString() ?? "",
    "SMS Sent Timestamp": candidate.smsSentAt?.toISOString() ?? "",
    "SMS Eligible Timestamp": candidate.smsEligibleAt?.toISOString() ?? "",
    "Stonegate Contact ID": cc.contactId,
    "Stonegate Campaign Contact ID": cc.id,
    "Street Name": mapped.street_name || cc.property?.streetName || "",
    Acreage: mapped.acreage || cc.property?.acreage?.toString() || "",
    "Source External ID":
      mapped.external_id ||
      cc.property?.externalId ||
      cc.contact.externalId ||
      "",
    "Stonegate Export ID": exportId,
  };
  if (type === "BATCH_DIALER") {
    for (const [header, value] of Object.entries(raw))
      base[`Original - ${header}`] = value;
  }
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
  stage?: OutreachSequenceState;
  date?: string;
  source?: string;
  creditedChannel?: AttributionChannel;
}

export interface CreateOutreachExportInput extends OutreachExportFilters {
  type: OutreachExportType;
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
    stage: input.stage ?? null,
    date: input.date ?? null,
    source: input.source?.trim() || null,
    creditedChannel: input.creditedChannel ?? null,
  };
}

function jsonRecord(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export function exportRequestMatchesExisting(
  existing: {
    type: OutreachExportType;
    campaignId: string | null;
    createdByUserId: string;
    intentionalRepeat: boolean;
    repeatReason: string | null;
    filtersSnapshot: Prisma.JsonValue | null;
  },
  input: CreateOutreachExportInput,
) {
  const stored = jsonRecord(existing.filtersSnapshot);
  const requestedFilters = exportFilterSnapshot(input);
  const existingFilters = {
    campaignId:
      typeof stored.campaignId === "string" ? stored.campaignId : null,
    stage: typeof stored.stage === "string" ? stored.stage : null,
    date: typeof stored.date === "string" ? stored.date : null,
    source: typeof stored.source === "string" ? stored.source : null,
    creditedChannel:
      typeof stored.creditedChannel === "string"
        ? stored.creditedChannel
        : null,
  };
  return (
    existing.type === input.type &&
    existing.campaignId === requestedFilters.campaignId &&
    existing.createdByUserId === input.user.id &&
    existing.intentionalRepeat === (input.intentionalRepeat === true) &&
    (existing.repeatReason ?? null) ===
      (input.intentionalRepeat ? input.repeatReason?.trim() || null : null) &&
    existingFilters.campaignId === requestedFilters.campaignId &&
    existingFilters.stage === requestedFilters.stage &&
    existingFilters.date === requestedFilters.date &&
    existingFilters.source === requestedFilters.source &&
    existingFilters.creditedChannel === requestedFilters.creditedChannel
  );
}

async function dateRange(date: string | undefined) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
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
  const reference = zonedDateTimeToUtc(
    { year, month, day, hour: 12, minute: 0 },
    timeZone,
  );
  return getLocalDayBounds(reference, timeZone);
}

export function campaignSpecificSourceFilter(
  source: string,
): Prisma.CampaignContactWhereInput {
  const match = { contains: source, mode: "insensitive" as const };
  return {
    OR: [
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
      {
        AND: [
          {
            OR: [
              { importRow: { is: null } },
              {
                importRow: {
                  is: { mappedData: { path: ["source"], equals: "" } },
                },
              },
            ],
          },
          { property: { is: { source: match } } },
        ],
      },
    ],
  };
}

async function candidateWhere(
  input: OutreachExportFilters & {
    type: OutreachExportType;
    intentionalRepeat: boolean;
  },
): Promise<Prisma.OutreachSequenceWhereInput> {
  const expectedState =
    input.type === "SMS_ELIGIBILITY" ? "SMS_ELIGIBLE" : "COLD_CALL_ELIGIBLE";
  const exportedState =
    input.type === "SMS_ELIGIBILITY" ? "SMS_EXPORTED" : "COLD_CALL_EXPORTED";
  const range = await dateRange(input.date);
  const campaignContactFilters: Prisma.CampaignContactWhereInput[] = [
    { leadAttribution: { is: null } },
    {
      contact: {
        suppressions: { none: {} },
        campaigns: { none: { leadAttribution: { isNot: null } } },
      },
    },
  ];
  if (input.campaignId)
    campaignContactFilters.push({ campaignId: input.campaignId });
  if (input.source?.trim())
    campaignContactFilters.push(
      campaignSpecificSourceFilter(input.source.trim()),
    );
  // Exportable contacts cannot already have lead attribution. Retaining the
  // credited-channel condition makes a filtered response view correctly yield
  // zero exportable rows instead of silently dropping that filter.
  if (input.creditedChannel)
    campaignContactFilters.push({
      leadAttribution: { is: { creditedChannel: input.creditedChannel } },
    });

  return {
    AND: [
      {
        currentState: input.intentionalRepeat
          ? { in: [expectedState, exportedState] }
          : expectedState,
      },
      ...(input.stage ? [{ currentState: input.stage }] : []),
      ...(range ? [{ lastEventAt: { gte: range.start, lt: range.end } }] : []),
    ],
    terminalAt: null,
    rvmSuccessfulAt: { not: null },
    ...(input.type === "BATCH_DIALER"
      ? { smsSentAt: { not: null }, smsRespondedAt: null }
      : {}),
    ...(input.intentionalRepeat
      ? {}
      : { exportClaims: { none: { type: input.type } } }),
    campaignContact: { AND: campaignContactFilters },
  };
}

export async function previewOutreachExport(
  input: OutreachExportFilters & { type: OutreachExportType },
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
  const exportedState =
    input.type === "SMS_ELIGIBILITY" ? "SMS_EXPORTED" : "COLD_CALL_EXPORTED";
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`outreach-export:${input.idempotencyKey}`}))::text`;
      const concurrentExisting = await tx.outreachExport.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (concurrentExisting)
        return assertIdempotentMatch(concurrentExisting, input);

      let candidates = await tx.outreachSequence.findMany({
        where,
        include: candidateInclude,
        orderBy: { lastEventAt: "asc" },
        take: MAX_OUTREACH_EXPORT_ROWS + 1,
      });
      if (candidates.length > MAX_OUTREACH_EXPORT_ROWS)
        throw new Error(
          `This export matches more than ${MAX_OUTREACH_EXPORT_ROWS.toLocaleString()} contacts; narrow the filters before exporting`,
        );
      if (candidates.length) {
        await tx.$queryRaw`
          SELECT "id" FROM "OutreachSequence"
          WHERE "id" IN (${Prisma.join(
            candidates.map((row) => Prisma.sql`${row.id}::uuid`),
          )})
          ORDER BY "id"
          FOR UPDATE
        `;
        const stillEligible = new Set(
          (
            await tx.outreachSequence.findMany({
              where: {
                AND: [where, { id: { in: candidates.map((row) => row.id) } }],
              },
              select: { id: true },
            })
          ).map((row) => row.id),
        );
        candidates = candidates.filter((row) => stillEligible.has(row.id));
      }
      const phones = [
        ...new Set(
          candidates.map((row) => row.campaignContact.contact.normalizedPhone),
        ),
      ];
      const suppressed = new Set(
        (
          await tx.suppressionEntry.findMany({
            where: { normalizedPhone: { in: phones } },
            select: { normalizedPhone: true },
          })
        ).map((row) => row.normalizedPhone),
      );
      const validCandidates = candidates.filter(
        (candidate) =>
          !suppressed.has(candidate.campaignContact.contact.normalizedPhone) &&
          normalizeUSPhone(
            candidate.campaignContact.contact.normalizedPhone,
          ) === candidate.campaignContact.contact.normalizedPhone,
      );
      if (!validCandidates.length)
        throw new Error("No eligible contacts match this export");

      const campaignLabel = input.campaignId
        ? (validCandidates[0]?.campaignContact.campaign.name ?? "campaign")
        : "all-campaigns";
      const draft = await tx.outreachExport.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          type: input.type,
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
      if (!intentionalRepeat) {
        await tx.outreachExportClaim.createMany({
          data: validCandidates.map((candidate) => ({
            sequenceId: candidate.id,
            type: input.type,
            firstExportId: draft.id,
          })),
          skipDuplicates: true,
        });
      }
      const claimedIds = intentionalRepeat
        ? new Set(validCandidates.map((candidate) => candidate.id))
        : new Set(
            (
              await tx.outreachExportClaim.findMany({
                where: { firstExportId: draft.id, type: input.type },
                select: { sequenceId: true },
              })
            ).map((claim) => claim.sequenceId),
          );
      const selected = validCandidates.filter((candidate) =>
        claimedIds.has(candidate.id),
      );
      if (!selected.length)
        throw new Error("Every matching contact was already exported");

      const priorCounts = intentionalRepeat
        ? await tx.outreachExportItem.groupBy({
            by: ["sequenceId"],
            where: {
              sequenceId: { in: selected.map((row) => row.id) },
              export: { type: input.type },
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
            input.type,
          ) as Prisma.InputJsonValue,
        })),
      });
      const now = new Date();
      await tx.outreachEvent.createMany({
        data: selected.map((candidate) => ({
          sequenceId: candidate.id,
          type:
            input.type === "SMS_ELIGIBILITY"
              ? ("SMS_EXPORTED" as const)
              : ("COLD_CALL_EXPORTED" as const),
          channel:
            input.type === "SMS_ELIGIBILITY"
              ? ("SMS" as const)
              : ("COLD_CALL" as const),
          resultingState: exportedState,
          occurredAt: now,
          source: "outreach_export",
          idempotencyKey: `export:${draft.id}:sequence:${candidate.id}`,
          actorUserId: input.user.id,
          metadata: { intentionalRepeat },
        })),
      });
      await tx.outreachSequence.updateMany({
        where: { id: { in: selected.map((candidate) => candidate.id) } },
        data: {
          currentState: exportedState,
          lastEventAt: now,
          version: { increment: 1 },
          ...(input.type === "SMS_ELIGIBILITY"
            ? { smsExportedAt: now }
            : { coldCallExportedAt: now }),
        },
      });
      const filename = `stonegate-${
        input.type === "SMS_ELIGIBILITY" ? "sms" : "batchdialer"
      }-${slug(campaignLabel)}-${now.toISOString().slice(0, 10)}-${draft.id.slice(
        0,
        8,
      )}.csv`;
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
  throw new Error("Could not create export");
}

export async function getOutreachExportCsv(exportId: string) {
  const result = await db.outreachExport.findUnique({
    where: { id: exportId },
    include: { items: { orderBy: { createdAt: "asc" } } },
  });
  if (!result) return null;
  const rows = result.items.map(
    (item) => item.rowSnapshot as Record<string, string>,
  );
  const fixedHeaders =
    result.type === "SMS_ELIGIBILITY"
      ? [...SMS_EXPORT_HEADERS]
      : [...BATCH_DIALER_HEADERS];
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
      [...fixedHeaders, ...originalHeaders],
      rows,
      new Set(["Phone"]),
    ),
  };
}
