import { type ExternalOutcomeChannel, Prisma } from "@prisma/client";
import { parse as parseCsv } from "csv-parse/sync";
import { db } from "@/lib/db";
import { assertExternalOutcomeAllowed } from "@/lib/external-outcome-policy";
import { normalizeUSPhone } from "@/lib/phone";
import { recordExternalOutcomeTx } from "@/lib/outreach-service";
import { sha256 } from "@/lib/utils";

export type ExternalOutcomeSourceRow = Record<string, string>;

const sequenceInclude = Prisma.validator<Prisma.OutreachSequenceInclude>()({
  campaignContact: {
    select: {
      id: true,
      contactId: true,
      contact: { select: { normalizedPhone: true } },
    },
  },
});

type MatchedSequence = Prisma.OutreachSequenceGetPayload<{
  include: typeof sequenceInclude;
}>;

export interface OutcomeIdentifiers {
  campaignContactId?: string;
  contactId?: string;
  normalizedPhone?: string;
}

export interface OutcomeIdentifierTarget {
  campaignContactId: string;
  contactId: string;
  normalizedPhone: string;
}

export interface ExternalOutcomePreviewRow {
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "REJECTED";
  identifier: string;
  result: string;
  occurredAt: string | null;
  error?: string;
}

export interface ExternalOutcomePreview {
  previewToken: string;
  confirmation: string;
  total: number;
  ready: number;
  duplicates: number;
  rejected: number;
  rows: ExternalOutcomePreviewRow[];
  errors: Array<{ rowNumber: number; error: string }>;
}

interface AnalyzedOutcome {
  rowNumber: number;
  row: ExternalOutcomeSourceRow;
  sequence: MatchedSequence;
  result: string;
  normalizedResult: string;
  occurredAt: Date;
  occurredAtWasSupplied: boolean;
  externalId?: string;
  idempotencyKey: string;
  duplicate: boolean;
  identifier: string;
}

function normalizedHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function normalizedRow(row: Record<string, unknown>): ExternalOutcomeSourceRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      normalizedHeader(key),
      value == null ? "" : String(value).trim(),
    ]),
  );
}

export function parseExternalOutcomeCsv(
  bytes: Buffer,
): ExternalOutcomeSourceRow[] {
  const rows = parseCsv(bytes, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, unknown>[];
  if (rows.length > 25_000)
    throw new Error("Outcome imports are limited to 25,000 rows");
  return rows.map(normalizedRow);
}

function first(row: ExternalOutcomeSourceRow, keys: string[]) {
  return keys.map((key) => row[key]).find(Boolean) ?? "";
}

export function normalizeExternalOutcomeResult(result: string) {
  return result
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function uuid(value: string, label: string) {
  if (
    value &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error(`${label} is invalid`);
  return value || undefined;
}

function identifiers(row: ExternalOutcomeSourceRow): OutcomeIdentifiers {
  const campaignContactId = uuid(
    first(row, ["stonegate_campaign_contact_id", "campaign_contact_id"]),
    "Stonegate Campaign Contact ID",
  );
  const contactId = uuid(
    first(row, ["stonegate_contact_id", "contact_id"]),
    "Stonegate Contact ID",
  );
  const phoneRaw = first(row, ["phone", "phone_number"]);
  const normalizedPhone = phoneRaw ? normalizeUSPhone(phoneRaw) : undefined;
  if (phoneRaw && !normalizedPhone) throw new Error("Phone is invalid");
  if (!campaignContactId && !contactId && !normalizedPhone)
    throw new Error(
      "Stonegate Campaign Contact ID, Stonegate Contact ID, or Phone is required",
    );
  return {
    campaignContactId,
    contactId,
    normalizedPhone: normalizedPhone ?? undefined,
  };
}

export function assertOutcomeIdentifiersMatch(
  provided: OutcomeIdentifiers,
  target: OutcomeIdentifierTarget,
) {
  if (
    provided.campaignContactId &&
    provided.campaignContactId !== target.campaignContactId
  )
    throw new Error("Stonegate Campaign Contact ID does not match the outcome");
  if (provided.contactId && provided.contactId !== target.contactId)
    throw new Error("Stonegate Contact ID does not match the outcome");
  if (
    provided.normalizedPhone &&
    provided.normalizedPhone !== target.normalizedPhone
  )
    throw new Error("Phone does not match the Stonegate contact");
}

function target(sequence: MatchedSequence): OutcomeIdentifierTarget {
  return {
    campaignContactId: sequence.campaignContact.id,
    contactId: sequence.campaignContact.contactId,
    normalizedPhone: sequence.campaignContact.contact.normalizedPhone,
  };
}

export function parseExternalOutcomeOccurrence(
  row: ExternalOutcomeSourceRow,
  channel: ExternalOutcomeChannel,
  normalizedResult: string,
  fallback: Date,
) {
  const raw =
    first(row, ["occurred_at", "timestamp"]) ||
    (channel === "SMS" && normalizedResult === "sent"
      ? first(row, ["sent_at"])
      : channel === "SMS"
        ? first(row, ["responded_at"])
        : first(row, ["contacted_at"]));
  if (channel === "SMS" && normalizedResult === "sent" && !raw)
    throw new Error("Sent At or Occurred At is required for an SMS sent row");
  if (!raw) return { value: fallback, raw: null };
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw))
    throw new Error("Occurred At must be ISO-8601 with a timezone");
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error("Occurred At is invalid");
  return { value, raw };
}

export function stableOutcomeIdempotencyKey(input: {
  channel: ExternalOutcomeChannel;
  sequenceId: string;
  normalizedResult: string;
  occurredAtRaw: string | null;
}) {
  return `outcome-fingerprint:${sha256(
    [
      input.channel,
      input.sequenceId,
      input.normalizedResult,
      input.occurredAtRaw ?? "timestamp-unspecified",
    ].join("\0"),
  )}`;
}

export function getExternalOutcomePreviewToken(
  channel: ExternalOutcomeChannel,
  bytes: Buffer,
) {
  return sha256(Buffer.concat([Buffer.from(`${channel}\0`), bytes]));
}

function externalIdempotencyKey(
  channel: ExternalOutcomeChannel,
  externalId: string,
  normalizedResult: string,
) {
  return `external-outcome:${channel}:${externalId}:${normalizedResult}`;
}

async function sequenceById(tx: Prisma.TransactionClient, id: string) {
  return tx.outreachSequence.findUnique({
    where: { id },
    include: sequenceInclude,
  });
}

async function matchSequenceForOutcome(
  tx: Prisma.TransactionClient,
  provided: OutcomeIdentifiers,
  allowMultipleForSuppression: boolean,
) {
  if (provided.campaignContactId) {
    const sequence = await tx.outreachSequence.findUnique({
      where: { campaignContactId: provided.campaignContactId },
      include: sequenceInclude,
    });
    if (!sequence) throw new Error("Unknown Stonegate campaign contact ID");
    assertOutcomeIdentifiersMatch(provided, target(sequence));
    return sequence;
  }

  if (provided.contactId && provided.normalizedPhone) {
    const contact = await tx.contact.findUnique({
      where: { id: provided.contactId },
      select: { normalizedPhone: true },
    });
    if (!contact) throw new Error("Unknown Stonegate contact ID");
    if (contact.normalizedPhone !== provided.normalizedPhone)
      throw new Error("Phone does not match the Stonegate contact");
  }

  const candidates = await tx.outreachSequence.findMany({
    where: {
      campaignContact: provided.contactId
        ? { contactId: provided.contactId }
        : { contact: { normalizedPhone: provided.normalizedPhone! } },
    },
    include: sequenceInclude,
    orderBy: { id: "asc" },
    take: 3,
  });
  if (candidates.length === 0)
    throw new Error("No Stonegate sequence matches this outcome");
  if (candidates.length > 1 && !allowMultipleForSuppression)
    throw new Error(
      "Outcome attribution is ambiguous; include Stonegate Campaign Contact ID",
    );
  assertOutcomeIdentifiersMatch(provided, target(candidates[0]));
  return candidates[0];
}

async function analyzeRow(
  tx: Prisma.TransactionClient,
  input: {
    channel: ExternalOutcomeChannel;
    row: ExternalOutcomeSourceRow;
    rowNumber: number;
    fallbackOccurredAt: Date;
  },
): Promise<AnalyzedOutcome> {
  const result = first(input.row, [
    "result",
    "outcome",
    "response_classification",
  ]);
  if (!result) throw new Error("Result is required");
  const normalizedResult = normalizeExternalOutcomeResult(result);
  const isSuppression = ["opt_out", "dnc", "wrong_number"].includes(
    normalizedResult,
  );
  const provided = identifiers(input.row);
  const externalId = first(input.row, ["external_id", "provider_id"]);
  const occurred = parseExternalOutcomeOccurrence(
    input.row,
    input.channel,
    normalizedResult,
    input.fallbackOccurredAt,
  );
  let sequence = await matchSequenceForOutcome(tx, provided, isSuppression);
  const stableIdentity = isSuppression
    ? `contact:${sequence.campaignContact.contactId}`
    : sequence.id;
  const idempotencyKey = externalId
    ? externalIdempotencyKey(input.channel, externalId, normalizedResult)
    : stableOutcomeIdempotencyKey({
        channel: input.channel,
        sequenceId: stableIdentity,
        normalizedResult,
        occurredAtRaw: occurred.raw,
      });
  let prior = await tx.outreachEvent.findFirst({
    where: {
      idempotencyKey: {
        in: [idempotencyKey, `${idempotencyKey}:sequence:${sequence.id}`],
      },
    },
    select: { sequenceId: true, outcome: true },
  });
  if (!prior && externalId) {
    const externalMatch = await tx.outreachEvent.findFirst({
      where: { channel: input.channel, externalId },
      select: { sequenceId: true, outcome: true },
    });
    if (externalMatch) {
      if (
        normalizeExternalOutcomeResult(externalMatch.outcome ?? "") !==
        normalizedResult
      )
        throw new Error("External ID was already used for a different outcome");
      const priorSequence = await sequenceById(tx, externalMatch.sequenceId);
      if (!priorSequence)
        throw new Error("The prior external outcome is orphaned");
      assertOutcomeIdentifiersMatch(provided, target(priorSequence));
      sequence = priorSequence;
      prior = externalMatch;
    }
  }
  if (prior) {
    if (
      (!isSuppression && prior.sequenceId !== sequence.id) ||
      normalizeExternalOutcomeResult(prior.outcome ?? "") !== normalizedResult
    )
      throw new Error("External outcome idempotency key conflict");
    if (isSuppression && prior.sequenceId !== sequence.id) {
      const priorSequence = await sequenceById(tx, prior.sequenceId);
      if (!priorSequence)
        throw new Error("The prior external outcome is orphaned");
      assertOutcomeIdentifiersMatch(provided, target(priorSequence));
      sequence = priorSequence;
    }
  } else {
    if (externalId) {
      const conflicting = await tx.outreachEvent.findFirst({
        where: { channel: input.channel, externalId },
        select: { sequenceId: true },
      });
      if (conflicting)
        throw new Error("External ID was already used for a different outcome");
    }
    assertExternalOutcomeAllowed(
      sequence,
      input.channel,
      result,
      occurred.value,
    );
  }
  return {
    rowNumber: input.rowNumber,
    row: input.row,
    sequence,
    result,
    normalizedResult,
    occurredAt: occurred.value,
    occurredAtWasSupplied: Boolean(occurred.raw),
    externalId: externalId || undefined,
    idempotencyKey,
    duplicate: Boolean(prior),
    identifier: sequence.campaignContact.id,
  };
}

function previewRow(result: AnalyzedOutcome): ExternalOutcomePreviewRow {
  return {
    rowNumber: result.rowNumber,
    status: result.duplicate ? "DUPLICATE" : "READY",
    identifier: result.identifier,
    result: result.result,
    occurredAt: result.occurredAtWasSupplied
      ? result.occurredAt.toISOString()
      : null,
  };
}

export async function previewExternalOutcomes(input: {
  channel: ExternalOutcomeChannel;
  bytes: Buffer;
}) {
  const rows = parseExternalOutcomeCsv(input.bytes);
  if (!rows.length) throw new Error("The CSV has no outcome rows");
  const fallbackOccurredAt = new Date();
  const previews: ExternalOutcomePreviewRow[] = [];
  const seenKeys = new Map<
    string,
    { sequenceId: string; normalizedResult: string }
  >();
  const seenExternalIds = new Map<
    string,
    { sequenceId: string; normalizedResult: string }
  >();
  await db.$transaction(
    async (tx) => {
      for (const [index, row] of rows.entries()) {
        const rowNumber = index + 2;
        try {
          const analyzed = await analyzeRow(tx, {
            channel: input.channel,
            row,
            rowNumber,
            fallbackOccurredAt,
          });
          const identity = {
            sequenceId: analyzed.sequence.id,
            normalizedResult: analyzed.normalizedResult,
          };
          if (analyzed.externalId) {
            const priorExternal = seenExternalIds.get(analyzed.externalId);
            if (
              priorExternal &&
              (priorExternal.sequenceId !== identity.sequenceId ||
                priorExternal.normalizedResult !== identity.normalizedResult)
            )
              throw new Error(
                "External ID is used by conflicting rows in this file",
              );
            seenExternalIds.set(analyzed.externalId, identity);
          }
          const priorKey = seenKeys.get(analyzed.idempotencyKey);
          if (
            priorKey &&
            (priorKey.sequenceId !== identity.sequenceId ||
              priorKey.normalizedResult !== identity.normalizedResult)
          )
            throw new Error("Outcome fingerprint conflicts within this file");
          if (priorKey) analyzed.duplicate = true;
          else seenKeys.set(analyzed.idempotencyKey, identity);
          previews.push(previewRow(analyzed));
        } catch (error) {
          previews.push({
            rowNumber,
            status: "REJECTED",
            identifier:
              first(row, [
                "stonegate_campaign_contact_id",
                "stonegate_contact_id",
                "phone",
              ]) || "—",
            result: first(row, [
              "result",
              "outcome",
              "response_classification",
            ]),
            occurredAt: null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
    { timeout: 60_000 },
  );
  const ready = previews.filter((row) => row.status === "READY").length;
  const duplicates = previews.filter(
    (row) => row.status === "DUPLICATE",
  ).length;
  const errors = previews.flatMap((row) =>
    row.error ? [{ rowNumber: row.rowNumber, error: row.error }] : [],
  );
  return {
    previewToken: getExternalOutcomePreviewToken(input.channel, input.bytes),
    confirmation: `IMPORT ${rows.length}`,
    total: rows.length,
    ready,
    duplicates,
    rejected: errors.length,
    rows: previews.slice(0, 50),
    errors: errors.slice(0, 100),
  } satisfies ExternalOutcomePreview;
}

async function commitRow(
  input: {
    channel: ExternalOutcomeChannel;
    row: ExternalOutcomeSourceRow;
    rowNumber: number;
    batchId: string;
    userId: string;
  },
  attempt = 1,
): Promise<"ACCEPTED" | "DUPLICATE"> {
  try {
    return await db.$transaction(
      async (tx) => {
        const externalId = first(input.row, ["external_id", "provider_id"]);
        if (externalId)
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`external-outcome:${input.channel}:${externalId}`}))::text`;
        const analyzed = await analyzeRow(tx, {
          channel: input.channel,
          row: input.row,
          rowNumber: input.rowNumber,
          fallbackOccurredAt: new Date(),
        });
        if (!analyzed.duplicate)
          await recordExternalOutcomeTx(tx, {
            sequenceId: analyzed.sequence.id,
            channel: input.channel,
            result: analyzed.result,
            occurredAt: analyzed.occurredAt,
            idempotencyKey: analyzed.idempotencyKey,
            externalId: analyzed.externalId,
            actorUserId: input.userId,
            rawPayload: analyzed.row,
          });
        await tx.externalOutcomeImportRow.create({
          data: {
            importId: input.batchId,
            sequenceId: analyzed.sequence.id,
            rowNumber: input.rowNumber,
            status: analyzed.duplicate ? "DUPLICATE" : "ACCEPTED",
            result: analyzed.result,
            externalId: analyzed.externalId,
            occurredAt: analyzed.occurredAt,
            rawData: analyzed.row,
          },
        });
        return analyzed.duplicate ? "DUPLICATE" : "ACCEPTED";
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    );
  } catch (error) {
    if (
      attempt < 3 &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2034" || error.code === "P2002")
    )
      return commitRow(input, attempt + 1);
    throw error;
  }
}

export async function importExternalOutcomes(input: {
  channel: ExternalOutcomeChannel;
  fileName: string;
  bytes: Buffer;
  userId: string;
}) {
  const rows = parseExternalOutcomeCsv(input.bytes);
  if (!rows.length) throw new Error("The CSV has no outcome rows");
  const batch = await db.externalOutcomeImport.create({
    data: {
      channel: input.channel,
      fileName: input.fileName,
      createdByUserId: input.userId,
      totalCount: rows.length,
    },
  });
  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;
  const errors: Array<{ rowNumber: number; error: string }> = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    try {
      const status = await commitRow({
        channel: input.channel,
        row,
        rowNumber,
        batchId: batch.id,
        userId: input.userId,
      });
      if (status === "DUPLICATE") duplicates += 1;
      else accepted += 1;
    } catch (error) {
      rejected += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ rowNumber, error: message });
      await db.externalOutcomeImportRow.create({
        data: {
          importId: batch.id,
          rowNumber,
          status: "REJECTED",
          result: first(row, ["result", "outcome"]),
          externalId: first(row, ["external_id", "provider_id"]) || undefined,
          errorMessage: message,
          rawData: row,
        },
      });
    }
  }
  const status =
    rejected === 0
      ? "COMPLETED"
      : accepted + duplicates > 0
        ? "PARTIAL"
        : "FAILED";
  await db.externalOutcomeImport.update({
    where: { id: batch.id },
    data: {
      status,
      acceptedCount: accepted + duplicates,
      rejectedCount: rejected,
      completedAt: new Date(),
    },
  });
  return {
    importId: batch.id,
    total: rows.length,
    accepted,
    duplicates,
    rejected,
    errors: errors.slice(0, 100),
  };
}
