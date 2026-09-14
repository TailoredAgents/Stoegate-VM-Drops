import {
  type ExternalOutcomeChannel,
  type OutreachEventType,
  type OutreachSequenceState,
  Prisma,
} from "@prisma/client";
import { parse as parseCsv } from "csv-parse/sync";
import { db } from "@/lib/db";
import {
  assertColdCallOutcomeAllowed,
  COLD_CALL_OUTCOMES,
  type ColdCallOutcome,
  type ColdCallOutcomeTransition,
  normalizeColdCallOutcome,
} from "@/lib/external-outcome-policy";
import { normalizeUSPhone } from "@/lib/phone";
import { lockSmsPhoneDispatchTx } from "@/lib/sms-dispatch-lock";
import { sha256 } from "@/lib/utils";

export type ExternalOutcomeSourceRow = Record<string, string>;

const batchDialerItemInclude =
  Prisma.validator<Prisma.OutreachExportItemInclude>()({
    export: {
      select: { id: true, type: true, createdAt: true },
    },
    sequence: {
      include: {
        campaignContact: {
          select: {
            id: true,
            contactId: true,
            contact: { select: { normalizedPhone: true } },
          },
        },
      },
    },
  });

type MatchedExportItem = Prisma.OutreachExportItemGetPayload<{
  include: typeof batchDialerItemInclude;
}>;

type MatchedSequence = MatchedExportItem["sequence"];

export interface OutcomeIdentifiers {
  exportItemId?: string;
  exportId?: string;
  campaignContactId?: string;
  contactId?: string;
  normalizedPhone?: string;
}

export interface OutcomeIdentifierTarget {
  exportItemId: string;
  exportId: string;
  campaignContactId: string;
  contactId: string;
  normalizedPhone: string;
}

export type ColdCallOutcomeMatchMethod =
  | "EXPORT_ITEM_ID"
  | "CAMPAIGN_CONTACT_ID"
  | "EXPORT_AND_CONTACT"
  | "EXPORT_AND_PHONE"
  | "EXPORT_ID"
  | "CONTACT_ID"
  | "PHONE";

export interface ColdCallOutcomePreviewRow {
  rowNumber: number;
  status: "READY" | "DUPLICATE" | "REJECTED";
  identifier: string;
  result: string;
  outcome: ColdCallOutcome | null;
  occurredAt: string | null;
  exportId?: string;
  campaignContactId?: string;
  matchMethod?: ColdCallOutcomeMatchMethod;
  error?: string;
}

export interface ColdCallOutcomePreview {
  previewToken: string;
  confirmation: string;
  total: number;
  ready: number;
  duplicates: number;
  rejected: number;
  outcomeCounts: Record<ColdCallOutcome, number>;
  rows: ColdCallOutcomePreviewRow[];
  errors: Array<{ rowNumber: number; error: string }>;
}

interface AnalyzedColdCallOutcome {
  rowNumber: number;
  row: ExternalOutcomeSourceRow;
  exportItem: MatchedExportItem;
  sequence: MatchedSequence;
  matchMethod: ColdCallOutcomeMatchMethod;
  result: string;
  outcome: ColdCallOutcome;
  occurredAt: Date;
  occurredAtWasSupplied: boolean;
  externalId?: string;
  idempotencyKey: string;
  duplicate: boolean;
  identifier: string;
}

interface CommittedRow {
  status: "ACCEPTED" | "DUPLICATE" | "REJECTED";
  error?: string;
}

function normalizedHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizedRow(row: Record<string, unknown>): ExternalOutcomeSourceRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      normalizedHeader(key),
      value == null ? "" : String(value).trim(),
    ]),
  );
}

export function parseColdCallOutcomeCsv(
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

function first(row: ExternalOutcomeSourceRow, keys: readonly string[]) {
  return keys.map((key) => row[key]).find(Boolean) ?? "";
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

export function coldCallOutcomeIdentifiers(
  row: ExternalOutcomeSourceRow,
): OutcomeIdentifiers {
  const exportItemId = uuid(
    first(row, ["stonegate_export_item_id", "outreach_export_item_id"]),
    "Stonegate Export Item ID",
  );
  const exportId = uuid(
    first(row, ["stonegate_export_id", "outreach_export_id", "export_id"]),
    "Stonegate Export ID",
  );
  const campaignContactId = uuid(
    first(row, ["stonegate_campaign_contact_id", "campaign_contact_id"]),
    "Stonegate Campaign Contact ID",
  );
  const contactId = uuid(
    first(row, ["stonegate_contact_id", "contact_id"]),
    "Stonegate Contact ID",
  );
  const phoneRaw = first(row, ["phone", "phone_number", "normalized_phone"]);
  const normalizedPhone = phoneRaw ? normalizeUSPhone(phoneRaw) : undefined;
  if (phoneRaw && !normalizedPhone) throw new Error("Phone is invalid");
  if (
    !exportItemId &&
    !exportId &&
    !campaignContactId &&
    !contactId &&
    !normalizedPhone
  )
    throw new Error(
      "Stonegate Export ID, Campaign Contact ID, Contact ID, or Phone is required",
    );
  return {
    exportItemId,
    exportId,
    campaignContactId,
    contactId,
    normalizedPhone: normalizedPhone ?? undefined,
  };
}

export function assertOutcomeIdentifiersMatch(
  provided: OutcomeIdentifiers,
  target: OutcomeIdentifierTarget,
) {
  if (provided.exportItemId && provided.exportItemId !== target.exportItemId)
    throw new Error("Stonegate Export Item ID does not match the outcome");
  if (provided.exportId && provided.exportId !== target.exportId)
    throw new Error("Stonegate Export ID does not match the outcome");
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

function target(item: MatchedExportItem): OutcomeIdentifierTarget {
  return {
    exportItemId: item.id,
    exportId: item.exportId,
    campaignContactId: item.sequence.campaignContact.id,
    contactId: item.sequence.campaignContact.contactId,
    normalizedPhone: item.sequence.campaignContact.contact.normalizedPhone,
  };
}

export function coldCallOutcomeMatchMethod(
  provided: OutcomeIdentifiers,
): ColdCallOutcomeMatchMethod {
  if (provided.exportItemId) return "EXPORT_ITEM_ID";
  if (provided.campaignContactId) return "CAMPAIGN_CONTACT_ID";
  if (provided.exportId && provided.contactId) return "EXPORT_AND_CONTACT";
  if (provided.exportId && provided.normalizedPhone) return "EXPORT_AND_PHONE";
  if (provided.exportId) return "EXPORT_ID";
  if (provided.contactId) return "CONTACT_ID";
  return "PHONE";
}

export function selectUniqueBatchDialerMatch<T extends { sequenceId: string }>(
  items: T[],
): T {
  if (!items.length)
    throw new Error(
      "The supplied identifiers do not match a BatchDialer export row",
    );
  const uniqueSequenceIds = new Set(items.map((item) => item.sequenceId));
  if (uniqueSequenceIds.size !== 1)
    throw new Error(
      "Outcome attribution is ambiguous; include Stonegate Campaign Contact ID and Export ID",
    );
  return items[0];
}

async function matchBatchDialerExportItem(
  tx: Prisma.TransactionClient,
  provided: OutcomeIdentifiers,
) {
  if (provided.exportItemId) {
    const item = await tx.outreachExportItem.findUnique({
      where: { id: provided.exportItemId },
      include: batchDialerItemInclude,
    });
    if (!item || item.export.type !== "BATCH_DIALER")
      throw new Error("Unknown BatchDialer export item ID");
    assertOutcomeIdentifiersMatch(provided, target(item));
    return {
      item,
      method: "EXPORT_ITEM_ID" as const,
    };
  }

  const campaignContactFilter: Prisma.CampaignContactWhereInput = {
    ...(provided.contactId ? { contactId: provided.contactId } : {}),
    ...(provided.normalizedPhone
      ? { contact: { normalizedPhone: provided.normalizedPhone } }
      : {}),
  };
  const items = await tx.outreachExportItem.findMany({
    where: {
      ...(provided.campaignContactId
        ? { campaignContactId: provided.campaignContactId }
        : {}),
      ...(provided.contactId || provided.normalizedPhone
        ? { campaignContact: campaignContactFilter }
        : {}),
      export: {
        type: "BATCH_DIALER",
        ...(provided.exportId ? { id: provided.exportId } : {}),
      },
    },
    include: batchDialerItemInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const item = selectUniqueBatchDialerMatch(items);
  assertOutcomeIdentifiersMatch(provided, target(item));
  return { item, method: coldCallOutcomeMatchMethod(provided) };
}

export function parseColdCallOutcomeOccurrence(
  row: ExternalOutcomeSourceRow,
  fallback: Date,
) {
  const raw = first(row, [
    "occurred_at",
    "timestamp",
    "contacted_at",
    "call_timestamp",
    "disposition_at",
    "completed_at",
  ]);
  if (!raw) return { value: fallback, raw: null };
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw))
    throw new Error("Occurred At must be ISO-8601 with a timezone");
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) throw new Error("Occurred At is invalid");
  return { value, raw };
}

export function stableColdCallOutcomeIdempotencyKey(input: {
  sequenceId: string;
  exportId: string;
  outcome: ColdCallOutcome;
  occurredAtIso: string | null;
}) {
  return `cold-call-outcome:${sha256(
    [
      input.sequenceId,
      input.exportId,
      input.outcome,
      input.occurredAtIso ?? "timestamp-unspecified",
    ].join("\0"),
  )}`;
}

function externalOutcomeIdempotencyKey(externalId: string) {
  return `cold-call-external:${sha256(externalId)}`;
}

export function getColdCallOutcomePreviewToken(bytes: Buffer) {
  return sha256(Buffer.concat([Buffer.from("COLD_CALL\0v1\0"), bytes]));
}

export function getColdCallOutcomeConfirmation(ready: number, total: number) {
  return `IMPORT COLD CALL ${ready} OF ${total}`;
}

function providerExternalId(row: ExternalOutcomeSourceRow) {
  return first(row, [
    "external_id",
    "provider_id",
    "outcome_id",
    "call_id",
    "record_id",
  ]);
}

function sourceResult(row: ExternalOutcomeSourceRow) {
  return first(row, [
    "result",
    "outcome",
    "disposition",
    "call_outcome",
    "response_classification",
  ]);
}

function primaryExternalEvent<
  T extends { idempotencyKey: string; sequenceId: string },
>(events: T[]) {
  return events.find(
    (event) => !event.idempotencyKey.endsWith(`:sequence:${event.sequenceId}`),
  );
}

async function priorExternalOutcome(
  tx: Prisma.TransactionClient,
  input: {
    idempotencyKey: string;
    externalId?: string;
    sequenceId: string;
    outcome: ColdCallOutcome;
  },
) {
  let prior = await tx.outreachEvent.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { sequenceId: true, outcome: true, idempotencyKey: true },
  });
  if (!prior && input.externalId) {
    const legacyMatches = await tx.outreachEvent.findMany({
      where: {
        externalId: input.externalId,
        source: "external_outcome_import",
      },
      select: { sequenceId: true, outcome: true, idempotencyKey: true },
    });
    prior = primaryExternalEvent(legacyMatches) ?? null;
  }
  if (!prior) return false;
  if (prior.sequenceId !== input.sequenceId)
    throw new Error(
      "External outcome identifier was already used for another contact",
    );
  let priorOutcome: ColdCallOutcome;
  try {
    priorOutcome = normalizeColdCallOutcome(prior.outcome ?? "");
  } catch {
    throw new Error(
      "External outcome idempotency key conflicts with another event",
    );
  }
  if (priorOutcome !== input.outcome)
    throw new Error(
      "External outcome identifier was already used for another outcome",
    );
  return true;
}

async function analyzeColdCallRow(
  tx: Prisma.TransactionClient,
  input: {
    row: ExternalOutcomeSourceRow;
    rowNumber: number;
    fallbackOccurredAt: Date;
  },
): Promise<AnalyzedColdCallOutcome> {
  const result = sourceResult(input.row);
  if (!result) throw new Error("Cold-call outcome is required");
  const outcome = normalizeColdCallOutcome(result);
  const provided = coldCallOutcomeIdentifiers(input.row);
  const matched = await matchBatchDialerExportItem(tx, provided);
  const sequence = matched.item.sequence;
  const externalId = providerExternalId(input.row);
  const occurred = parseColdCallOutcomeOccurrence(
    input.row,
    input.fallbackOccurredAt,
  );
  const idempotencyKey = externalId
    ? externalOutcomeIdempotencyKey(externalId)
    : stableColdCallOutcomeIdempotencyKey({
        sequenceId: sequence.id,
        exportId: matched.item.exportId,
        outcome,
        occurredAtIso: occurred.raw ? occurred.value.toISOString() : null,
      });
  const duplicate = await priorExternalOutcome(tx, {
    idempotencyKey,
    externalId: externalId || undefined,
    sequenceId: sequence.id,
    outcome,
  });
  if (!duplicate)
    assertColdCallOutcomeAllowed(sequence, outcome, occurred.value);
  return {
    rowNumber: input.rowNumber,
    row: input.row,
    exportItem: matched.item,
    sequence,
    matchMethod: matched.method,
    result,
    outcome,
    occurredAt: occurred.value,
    occurredAtWasSupplied: Boolean(occurred.raw),
    externalId: externalId || undefined,
    idempotencyKey,
    duplicate,
    identifier: sequence.campaignContact.id,
  };
}

function previewRow(
  result: AnalyzedColdCallOutcome,
): ColdCallOutcomePreviewRow {
  return {
    rowNumber: result.rowNumber,
    status: result.duplicate ? "DUPLICATE" : "READY",
    identifier: result.identifier,
    result: result.result,
    outcome: result.outcome,
    occurredAt: result.occurredAtWasSupplied
      ? result.occurredAt.toISOString()
      : null,
    exportId: result.exportItem.exportId,
    campaignContactId: result.sequence.campaignContact.id,
    matchMethod: result.matchMethod,
  };
}

function emptyOutcomeCounts(): Record<ColdCallOutcome, number> {
  return Object.fromEntries(
    COLD_CALL_OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<ColdCallOutcome, number>;
}

export async function previewColdCallOutcomes(input: { bytes: Buffer }) {
  const rows = parseColdCallOutcomeCsv(input.bytes);
  if (!rows.length) throw new Error("The CSV has no outcome rows");
  const fallbackOccurredAt = new Date();
  const previews: ColdCallOutcomePreviewRow[] = [];
  const seenKeys = new Map<
    string,
    { sequenceId: string; outcome: ColdCallOutcome }
  >();
  await db.$transaction(
    async (tx) => {
      for (const [index, row] of rows.entries()) {
        const rowNumber = index + 2;
        try {
          const analyzed = await analyzeColdCallRow(tx, {
            row,
            rowNumber,
            fallbackOccurredAt,
          });
          const identity = {
            sequenceId: analyzed.sequence.id,
            outcome: analyzed.outcome,
          };
          const prior = seenKeys.get(analyzed.idempotencyKey);
          if (
            prior &&
            (prior.sequenceId !== identity.sequenceId ||
              prior.outcome !== identity.outcome)
          )
            throw new Error(
              "External outcome identifier conflicts within this file",
            );
          if (prior) analyzed.duplicate = true;
          else seenKeys.set(analyzed.idempotencyKey, identity);
          previews.push(previewRow(analyzed));
        } catch (error) {
          previews.push({
            rowNumber,
            status: "REJECTED",
            identifier:
              first(row, [
                "stonegate_export_item_id",
                "stonegate_export_id",
                "stonegate_campaign_contact_id",
                "stonegate_contact_id",
                "phone",
              ]) || "(none)",
            result: sourceResult(row),
            outcome: null,
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
  const outcomeCounts = emptyOutcomeCounts();
  for (const row of previews) {
    if (row.outcome) outcomeCounts[row.outcome] += 1;
  }
  return {
    previewToken: getColdCallOutcomePreviewToken(input.bytes),
    confirmation: getColdCallOutcomeConfirmation(ready, rows.length),
    total: rows.length,
    ready,
    duplicates,
    rejected: errors.length,
    outcomeCounts,
    rows: previews.slice(0, 50),
    errors: errors.slice(0, 100),
  } satisfies ColdCallOutcomePreview;
}

function importMarkerKey(previewToken: string) {
  return `cold-call-import:${previewToken}`;
}

async function ensureImportBatch(input: {
  previewToken: string;
  fileName: string;
  total: number;
  userId: string;
}) {
  const markerKey = importMarkerKey(input.previewToken);
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${markerKey}))::text AS locked
      `;
      const marker = await tx.smsAuditEvent.findUnique({
        where: { idempotencyKey: markerKey },
      });
      if (marker) {
        if (marker.entityType !== "ExternalOutcomeImport")
          throw new Error("Cold-call import idempotency marker is invalid");
        const existing = await tx.externalOutcomeImport.findUnique({
          where: { id: marker.entityId },
        });
        if (!existing || existing.channel !== "COLD_CALL")
          throw new Error("Cold-call import audit record is orphaned");
        return existing;
      }
      const occurredAt = new Date();
      const batch = await tx.externalOutcomeImport.create({
        data: {
          channel: "COLD_CALL",
          fileName: input.fileName,
          createdByUserId: input.userId,
          totalCount: input.total,
        },
      });
      await tx.smsAuditEvent.create({
        data: {
          eventType: "COLD_CALL_OUTCOME_IMPORT_CREATED",
          entityType: "ExternalOutcomeImport",
          entityId: batch.id,
          actorUserId: input.userId,
          idempotencyKey: markerKey,
          source: "cold_call_outcome_import",
          occurredAt,
          metadata: {
            previewToken: input.previewToken,
            fileName: input.fileName,
            total: input.total,
          },
        },
      });
      return batch;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    },
  );
}

function auditedRowPayload(analyzed: AnalyzedColdCallOutcome) {
  return {
    sourceRow: analyzed.row,
    stonegateMatch: {
      method: analyzed.matchMethod,
      exportItemId: analyzed.exportItem.id,
      exportId: analyzed.exportItem.exportId,
      sequenceId: analyzed.sequence.id,
      campaignContactId: analyzed.sequence.campaignContact.id,
      contactId: analyzed.sequence.campaignContact.contactId,
      normalizedPhone:
        analyzed.sequence.campaignContact.contact.normalizedPhone,
      canonicalOutcome: analyzed.outcome,
    },
  } as Prisma.InputJsonValue;
}

const leadProgression: Partial<Record<OutreachSequenceState, number>> = {
  INTERESTED: 1,
  QUALIFIED_LEAD: 2,
  CONTRACT: 3,
  CLOSED: 4,
};

function resolveOutcomeState(
  current: OutreachSequenceState,
  proposed: OutreachSequenceState,
) {
  if (current === "OPT_OUT" || current === "WRONG_NUMBER") return current;
  if (proposed === "OPT_OUT" || proposed === "WRONG_NUMBER") return proposed;
  if ((leadProgression[current] ?? 0) > (leadProgression[proposed] ?? 0))
    return current;
  return proposed;
}

function leadOutcomeRank(value: string) {
  try {
    const outcome = normalizeColdCallOutcome(value);
    return outcome === "INTERESTED"
      ? 1
      : outcome === "QUALIFIED_LEAD"
        ? 2
        : outcome === "CONTRACT"
          ? 3
          : outcome === "CLOSED"
            ? 4
            : 0;
  } catch {
    return 0;
  }
}

function coldCallEventType(
  transition: ColdCallOutcomeTransition,
): OutreachEventType {
  if (transition.state === "COLD_CALL_CONTACTED") return "COLD_CALL_CONTACTED";
  if (transition.state === "COLD_CALL_NO_ANSWER") return "COLD_CALL_NO_ANSWER";
  return "OUTCOME_RECORDED";
}

async function lockSequenceTx(
  tx: Prisma.TransactionClient,
  sequenceId: string,
) {
  await tx.$queryRaw`
    SELECT "id" FROM "OutreachSequence"
    WHERE "id" = ${sequenceId}::uuid
    FOR UPDATE
  `;
  return tx.outreachSequence.findUniqueOrThrow({ where: { id: sequenceId } });
}

async function recordLeadAttributionTx(
  tx: Prisma.TransactionClient,
  input: {
    campaignContactId: string;
    campaignId: string;
    creditedEventId: string;
    outcome: ColdCallOutcome;
    occurredAt: Date;
  },
) {
  const existing = await tx.leadAttribution.findUnique({
    where: { campaignContactId: input.campaignContactId },
  });
  if (!existing)
    return tx.leadAttribution.create({
      data: {
        campaignContactId: input.campaignContactId,
        campaignId: input.campaignId,
        creditedChannel: "COLD_CALL",
        creditedEventId: input.creditedEventId,
        qualifyingOutcome: input.outcome,
        attributedAt: input.occurredAt,
      },
    });
  if (
    leadOutcomeRank(input.outcome) > leadOutcomeRank(existing.qualifyingOutcome)
  )
    return tx.leadAttribution.update({
      where: { id: existing.id },
      data: { qualifyingOutcome: input.outcome },
    });
  return existing;
}

async function recordColdCallOutcomeTx(
  tx: Prisma.TransactionClient,
  input: {
    analyzed: AnalyzedColdCallOutcome;
    userId: string;
    rawPayload: Prisma.InputJsonValue;
  },
) {
  const { analyzed } = input;
  const prior = await tx.outreachEvent.findUnique({
    where: { idempotencyKey: analyzed.idempotencyKey },
  });
  if (prior) {
    let priorOutcome: ColdCallOutcome;
    try {
      priorOutcome = normalizeColdCallOutcome(prior.outcome ?? "");
    } catch {
      throw new Error("Cold-call outcome idempotency key conflict");
    }
    if (
      prior.sequenceId !== analyzed.sequence.id ||
      priorOutcome !== analyzed.outcome
    )
      throw new Error("Cold-call outcome idempotency key conflict");
    return { duplicate: true as const };
  }

  const target = await tx.outreachSequence.findUniqueOrThrow({
    where: { id: analyzed.sequence.id },
    include: {
      campaignContact: {
        include: { contact: { select: { id: true, normalizedPhone: true } } },
      },
    },
  });
  const phone = target.campaignContact.contact.normalizedPhone;
  const transition = assertColdCallOutcomeAllowed(
    target,
    analyzed.outcome,
    analyzed.occurredAt,
  );
  const affectsOtherSmsSequences = transition.lead || transition.suppress;
  if (affectsOtherSmsSequences) await lockSmsPhoneDispatchTx(tx, phone);
  const sequences = await tx.outreachSequence.findMany({
    where: affectsOtherSmsSequences
      ? {
          campaignContact: {
            contact: { normalizedPhone: phone },
            campaign: { kind: "SMS" },
          },
        }
      : { id: target.id },
    include: { campaignContact: { select: { id: true, campaignId: true } } },
    orderBy: { id: "asc" },
  });
  let targetRecorded = false;
  for (const sequence of sequences) {
    const current = await lockSequenceTx(tx, sequence.id);
    const isTarget = sequence.id === target.id;
    if (isTarget) {
      assertColdCallOutcomeAllowed(
        current,
        analyzed.outcome,
        analyzed.occurredAt,
      );
      targetRecorded = true;
    } else if (current.terminalAt) {
      continue;
    }

    const resultingState = resolveOutcomeState(
      current.currentState,
      transition.state,
    );
    const event = await tx.outreachEvent.create({
      data: {
        sequenceId: sequence.id,
        type: isTarget ? coldCallEventType(transition) : "SEQUENCE_EXITED",
        channel: isTarget ? "COLD_CALL" : "SYSTEM",
        resultingState,
        outcome: analyzed.outcome,
        source: "cold_call_outcome_import",
        externalId: analyzed.externalId,
        idempotencyKey: isTarget
          ? analyzed.idempotencyKey
          : `${analyzed.idempotencyKey}:sequence:${sequence.id}`,
        actorUserId: input.userId,
        rawPayload: input.rawPayload,
        occurredAt: analyzed.occurredAt,
      },
    });
    await tx.outreachSequence.update({
      where: { id: sequence.id },
      data: {
        currentState: resultingState,
        terminalAt: current.terminalAt ?? analyzed.occurredAt,
        terminalReason: resultingState,
        nextEligibleAt: null,
        lastEventAt: analyzed.occurredAt,
        version: { increment: 1 },
      },
    });
    if (isTarget && transition.lead)
      await recordLeadAttributionTx(tx, {
        campaignContactId: sequence.campaignContact.id,
        campaignId: sequence.campaignContact.campaignId,
        creditedEventId: event.id,
        outcome: analyzed.outcome,
        occurredAt: analyzed.occurredAt,
      });
  }
  if (!targetRecorded)
    throw new Error("Cold-call outcome target sequence was not found");

  if (transition.suppress) {
    const desiredReason =
      analyzed.outcome === "DNC" ? "PROVIDER_DNC" : "WRONG_NUMBER";
    const existingSuppression = await tx.suppressionEntry.findUnique({
      where: { normalizedPhone: phone },
      select: { reason: true },
    });
    const suppressionReason =
      existingSuppression?.reason === "OPT_OUT" ? "OPT_OUT" : desiredReason;
    await tx.suppressionEntry.upsert({
      where: { normalizedPhone: phone },
      create: {
        normalizedPhone: phone,
        contactId: target.campaignContact.contact.id,
        reason: suppressionReason,
        source: "cold_call_outcome_import",
        createdByUserId: input.userId,
      },
      update: {
        reason: suppressionReason,
        source: "cold_call_outcome_import",
        createdByUserId: input.userId,
      },
    });
  }
  return { duplicate: false as const };
}

async function commitRow(
  input: {
    row: ExternalOutcomeSourceRow;
    rowNumber: number;
    batchId: string;
    userId: string;
  },
  attempt = 1,
): Promise<CommittedRow> {
  try {
    return await db.$transaction(
      async (tx) => {
        const externalId = providerExternalId(input.row);
        const lockKey = externalId
          ? `cold-call-external:${externalId}`
          : `cold-call-row:${sha256(JSON.stringify(input.row))}`;
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;
        const existing = await tx.externalOutcomeImportRow.findUnique({
          where: {
            importId_rowNumber: {
              importId: input.batchId,
              rowNumber: input.rowNumber,
            },
          },
        });
        if (existing)
          return {
            status: existing.status,
            error: existing.errorMessage ?? undefined,
          };

        const analyzed = await analyzeColdCallRow(tx, {
          row: input.row,
          rowNumber: input.rowNumber,
          fallbackOccurredAt: new Date(),
        });
        let duplicate = analyzed.duplicate;
        if (!duplicate) {
          const recorded = await recordColdCallOutcomeTx(tx, {
            analyzed,
            userId: input.userId,
            rawPayload: auditedRowPayload(analyzed),
          });
          duplicate = recorded.duplicate;
        }
        await tx.externalOutcomeImportRow.create({
          data: {
            importId: input.batchId,
            sequenceId: analyzed.sequence.id,
            rowNumber: input.rowNumber,
            status: duplicate ? "DUPLICATE" : "ACCEPTED",
            result: analyzed.outcome,
            externalId: analyzed.externalId,
            occurredAt: analyzed.occurredAt,
            rawData: auditedRowPayload(analyzed),
          },
        });
        return { status: duplicate ? "DUPLICATE" : "ACCEPTED" };
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

async function persistRejectedRow(
  input: {
    row: ExternalOutcomeSourceRow;
    rowNumber: number;
    batchId: string;
    error: string;
  },
  attempt = 1,
): Promise<CommittedRow> {
  try {
    return await db.$transaction(
      async (tx) => {
        const lockKey = `cold-call-import-row:${input.batchId}:${input.rowNumber}`;
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;
        const existing = await tx.externalOutcomeImportRow.findUnique({
          where: {
            importId_rowNumber: {
              importId: input.batchId,
              rowNumber: input.rowNumber,
            },
          },
        });
        if (existing)
          return {
            status: existing.status,
            error: existing.errorMessage ?? undefined,
          };
        await tx.externalOutcomeImportRow.create({
          data: {
            importId: input.batchId,
            rowNumber: input.rowNumber,
            status: "REJECTED",
            result: sourceResult(input.row) || undefined,
            externalId: providerExternalId(input.row) || undefined,
            errorMessage: input.error,
            rawData: { sourceRow: input.row },
          },
        });
        return { status: "REJECTED", error: input.error };
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
      return persistRejectedRow(input, attempt + 1);
    throw error;
  }
}

async function summarizeImport(importId: string, total: number) {
  const [groups, errors] = await Promise.all([
    db.externalOutcomeImportRow.groupBy({
      by: ["status"],
      where: { importId },
      _count: { _all: true },
    }),
    db.externalOutcomeImportRow.findMany({
      where: { importId, status: "REJECTED" },
      select: { rowNumber: true, errorMessage: true },
      orderBy: { rowNumber: "asc" },
      take: 100,
    }),
  ]);
  const count = (status: "ACCEPTED" | "DUPLICATE" | "REJECTED") =>
    groups.find((group) => group.status === status)?._count._all ?? 0;
  return {
    importId,
    total,
    accepted: count("ACCEPTED"),
    duplicates: count("DUPLICATE"),
    rejected: count("REJECTED"),
    errors: errors.map((row) => ({
      rowNumber: row.rowNumber,
      error: row.errorMessage ?? "Outcome row was rejected",
    })),
  };
}

export async function importColdCallOutcomes(input: {
  fileName: string;
  bytes: Buffer;
  userId: string;
  previewToken: string;
}) {
  const expectedToken = getColdCallOutcomePreviewToken(input.bytes);
  if (input.previewToken !== expectedToken)
    throw new Error("The file changed after preview");
  const rows = parseColdCallOutcomeCsv(input.bytes);
  if (!rows.length) throw new Error("The CSV has no outcome rows");
  const batch = await ensureImportBatch({
    previewToken: expectedToken,
    fileName: input.fileName,
    total: rows.length,
    userId: input.userId,
  });

  if (batch.status !== "PROCESSING")
    return summarizeImport(batch.id, rows.length);

  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    try {
      await commitRow({
        row,
        rowNumber,
        batchId: batch.id,
        userId: input.userId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persistRejectedRow({
        row,
        rowNumber,
        batchId: batch.id,
        error: message,
      });
    }
  }

  const summary = await summarizeImport(batch.id, rows.length);
  const status =
    summary.rejected === 0
      ? "COMPLETED"
      : summary.accepted + summary.duplicates > 0
        ? "PARTIAL"
        : "FAILED";
  const completedAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.externalOutcomeImport.update({
      where: { id: batch.id },
      data: {
        status,
        acceptedCount: summary.accepted + summary.duplicates,
        rejectedCount: summary.rejected,
        completedAt,
      },
    });
    await tx.smsAuditEvent.createMany({
      data: [
        {
          eventType: "COLD_CALL_OUTCOME_IMPORT_COMPLETED",
          entityType: "ExternalOutcomeImport",
          entityId: batch.id,
          actorUserId: input.userId,
          idempotencyKey: `${importMarkerKey(expectedToken)}:completed`,
          source: "cold_call_outcome_import",
          occurredAt: completedAt,
          after: {
            total: summary.total,
            accepted: summary.accepted,
            duplicates: summary.duplicates,
            rejected: summary.rejected,
            status,
          },
        },
      ],
      skipDuplicates: true,
    });
  });
  return summary;
}

function requireColdCallChannel(channel: ExternalOutcomeChannel) {
  if (channel !== "COLD_CALL")
    throw new Error("Only COLD_CALL outcomes can be imported");
}

/** @deprecated Use getColdCallOutcomePreviewToken. */
export function getExternalOutcomePreviewToken(
  channel: ExternalOutcomeChannel,
  bytes: Buffer,
) {
  requireColdCallChannel(channel);
  return getColdCallOutcomePreviewToken(bytes);
}

/** @deprecated Use previewColdCallOutcomes. */
export function previewExternalOutcomes(input: {
  channel: ExternalOutcomeChannel;
  bytes: Buffer;
}) {
  requireColdCallChannel(input.channel);
  return previewColdCallOutcomes({ bytes: input.bytes });
}

/** @deprecated Use importColdCallOutcomes. */
export function importExternalOutcomes(input: {
  channel: ExternalOutcomeChannel;
  fileName: string;
  bytes: Buffer;
  userId: string;
  previewToken: string;
}) {
  requireColdCallChannel(input.channel);
  return importColdCallOutcomes(input);
}
