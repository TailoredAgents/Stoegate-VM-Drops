import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import type { CanonicalField } from "@/lib/import-fields";
import { getAppSettings } from "@/lib/settings";

const IMPORT_COMMIT_TIMEOUT_MS = 10 * 60 * 1000;

type Mapped = Record<CanonicalField, string>;

export interface CommitSmsImportInput {
  batchId: string;
  campaignName: string;
  sourceName?: string;
  smsTemplateVersionId: string;
  sendLimit?: number;
  dailySendCap?: number;
  timezone: string;
  scheduledFor: Date | null;
  sendWindowStartMinutes: number;
  sendWindowEndMinutes: number;
  coldCallDelayHours?: number;
  complianceNotes?: string;
  createdByUserId: string;
}

export class ImportCommitConflictError extends Error {
  constructor() {
    super("Import batch has already been committed");
    this.name = "ImportCommitConflictError";
  }
}

export class InactiveSmsTemplateVersionError extends Error {
  constructor() {
    super("Selected SMS template version is not active");
    this.name = "InactiveSmsTemplateVersionError";
  }
}

function assertInserted(
  entity: string,
  insertedCount: number,
  expectedCount: number,
) {
  if (insertedCount !== expectedCount) {
    throw new Error(
      `Import invariant failed for ${entity}: expected ${expectedCount}, inserted ${insertedCount}`,
    );
  }
}

/**
 * Materializes an analyzed import as one atomic database operation.
 *
 * The transaction-scoped advisory lock rejects concurrent commits for the same
 * batch, while the row lock and guarded final update protect the batch state.
 * Any error, including one after an earlier 500-row page, rolls back the
 * campaign and every contact/property/sequence created by this attempt.
 */
export async function commitSmsImport(input: CommitSmsImportInput) {
  const env = getEnv();

  return db.$transaction(
    async (tx) => {
      const lockKey = `sms-import-commit:${input.batchId}`;
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
      `;
      if (!lock?.locked) throw new ImportCommitConflictError();

      const lockedBatch = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "ImportBatch"
        WHERE "id" = ${input.batchId}::uuid
        FOR UPDATE
      `;
      if (!lockedBatch.length) {
        await tx.importBatch.findUniqueOrThrow({
          where: { id: input.batchId },
        });
      }

      const batch = await tx.importBatch.findUniqueOrThrow({
        where: { id: input.batchId },
      });
      if (batch.status !== "ANALYZED" || batch.campaignId) {
        throw new ImportCommitConflictError();
      }

      // Refuse to build on top of remnants created by an interrupted version
      // of the old non-atomic importer.
      const claimedRows = await tx.campaignContact.count({
        where: { importRow: { importBatchId: batch.id } },
      });
      if (claimedRows) throw new ImportCommitConflictError();

      const templateVersion = await tx.smsTemplateVersion.findUniqueOrThrow({
        where: { id: input.smsTemplateVersionId },
        include: { template: true },
      });
      if (
        !templateVersion.template.active ||
        templateVersion.status === "RETIRED"
      ) {
        throw new InactiveSmsTemplateVersionError();
      }

      const settings = await getAppSettings(tx);
      const sendLimit = input.sendLimit ?? env.DEFAULT_DAILY_SMS_LIMIT;
      const dailyCap = input.dailySendCap ?? env.DEFAULT_DAILY_SMS_LIMIT;
      const delayHours =
        input.coldCallDelayHours ?? env.DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS;

      const campaign = await tx.campaign.create({
        data: {
          name: input.campaignName,
          sourceName: input.sourceName || batch.fileName,
          kind: "SMS",
          status: "DRAFT",
          sendLimit,
          smsDailyCap: dailyCap,
          uploadedCount: batch.uploadedCount,
          eligibleCount: batch.eligibleCount,
          invalidCount: batch.invalidCount,
          duplicateCount: batch.duplicateCount,
          suppressedCount: batch.suppressedCount,
          smsTemplateVersionId: templateVersion.id,
          smsProviderKey: env.SMS_PROVIDER,
          smsSenderRef:
            env.SMS_PROVIDER.toLowerCase() === "twilio"
              ? env.TWILIO_MESSAGING_SERVICE_SID
              : undefined,
          smsProviderConfig:
            env.SMS_PROVIDER.toLowerCase() === "twilio" &&
            env.TWILIO_MESSAGING_SERVICE_SID
              ? {
                  routing: "messaging_service",
                  messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
                }
              : undefined,
          smsScheduleTimezone: input.timezone,
          smsScheduledFor: input.scheduledFor,
          smsSendWindowStartMinutes: input.sendWindowStartMinutes,
          smsSendWindowEndMinutes: input.sendWindowEndMinutes,
          smsEstimatedCostPerSegmentMicros:
            settings.sms_cost_per_segment_micros +
            settings.sms_carrier_surcharge_per_outbound_segment_micros,
          smsCostConfig: {
            fixedMonthlyProviderFeeCents:
              settings.sms_provider_fixed_monthly_fee_cents,
            costPerOutboundMessageMicros:
              settings.sms_cost_per_outbound_message_micros,
            costPerSegmentMicros: settings.sms_cost_per_segment_micros,
            carrierSurchargePerOutboundSegmentMicros:
              settings.sms_carrier_surcharge_per_outbound_segment_micros,
            costPerInboundMessageMicros:
              settings.sms_cost_per_inbound_message_micros,
            phoneNumberMonthlyCostCents:
              settings.sms_phone_number_monthly_cents,
            registrationMonthlyCostCents:
              settings.sms_registration_monthly_cents,
          },
          smsComplianceStatus: "DRAFT",
          smsComplianceNotes: input.complianceNotes,
          smsColdCallDelayHours: delayHours,
          createdByUserId: input.createdByUserId,
        },
      });

      let cursor: string | undefined;
      do {
        const rows = await tx.importRow.findMany({
          where: { importBatchId: batch.id, status: "ELIGIBLE" },
          orderBy: { id: "asc" },
          take: 500,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        if (!rows.length) break;
        cursor = rows.at(-1)!.id;

        const phones = [
          ...new Set(rows.map((row) => row.normalizedPhone!).filter(Boolean)),
        ];
        const firstByPhone = new Map<
          string,
          { mapped: Mapped; raw: Prisma.JsonValue }
        >();
        for (const row of rows) {
          if (!firstByPhone.has(row.normalizedPhone!)) {
            firstByPhone.set(row.normalizedPhone!, {
              mapped: row.mappedData as Mapped,
              raw: row.rawData,
            });
          }
        }

        await tx.contact.createMany({
          data: [...firstByPhone.entries()].map(([phone, value]) => ({
            normalizedPhone: phone,
            firstName: value.mapped.first_name || null,
            lastName: value.mapped.last_name || null,
            ownerName: value.mapped.owner_name || null,
            source: value.mapped.source || null,
            externalId: value.mapped.external_id || null,
            rawData: value.raw as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });
        const contacts = await tx.contact.findMany({
          where: { normalizedPhone: { in: phones } },
          select: { id: true, normalizedPhone: true },
        });
        const contactByPhone = new Map(
          contacts.map((contact) => [contact.normalizedPhone, contact.id]),
        );
        const prepared = rows.map((row) => {
          const mapped = row.mappedData as Mapped;
          return {
            row,
            mapped,
            propertyId: randomUUID(),
            contactId: contactByPhone.get(row.normalizedPhone!)!,
          };
        });

        const properties = await tx.property.createMany({
          data: prepared.map(({ mapped, propertyId, row }) => ({
            id: propertyId,
            propertyAddress: mapped.property_address || null,
            streetName: mapped.street_name || null,
            city: mapped.city || null,
            state: mapped.state || null,
            postalCode: mapped.postal_code || null,
            county: mapped.county || null,
            acreage:
              mapped.acreage && !Number.isNaN(Number(mapped.acreage))
                ? new Prisma.Decimal(mapped.acreage)
                : null,
            propertyType: mapped.property_type || null,
            externalId: mapped.external_id || null,
            source: mapped.source || null,
            rawData: row.rawData as Prisma.InputJsonValue,
          })),
        });
        assertInserted("properties", properties.count, prepared.length);

        const contactProperties = await tx.contactProperty.createMany({
          data: prepared.map(({ contactId, propertyId }) => ({
            contactId,
            propertyId,
          })),
        });
        assertInserted(
          "contact properties",
          contactProperties.count,
          prepared.length,
        );

        const campaignContactResult = await tx.campaignContact.createMany({
          data: prepared.map(({ row, contactId, propertyId }) => ({
            campaignId: campaign.id,
            contactId,
            propertyId,
            importRowId: row.id,
          })),
        });
        assertInserted(
          "campaign contacts",
          campaignContactResult.count,
          prepared.length,
        );

        const campaignContacts = await tx.campaignContact.findMany({
          where: {
            campaignId: campaign.id,
            importRowId: { in: prepared.map(({ row }) => row.id) },
          },
          select: { id: true },
        });
        assertInserted(
          "materialized campaign contacts",
          campaignContacts.length,
          prepared.length,
        );

        const sequenceResult = await tx.outreachSequence.createMany({
          data: campaignContacts.map(({ id }) => ({
            campaignContactId: id,
            currentState: "SMS_PENDING" as const,
            smsToColdCallDelayHours: delayHours,
          })),
        });
        assertInserted(
          "outreach sequences",
          sequenceResult.count,
          campaignContacts.length,
        );

        const sequences = await tx.outreachSequence.findMany({
          where: {
            campaignContactId: { in: campaignContacts.map(({ id }) => id) },
          },
          select: { id: true, campaignContactId: true, createdAt: true },
        });
        assertInserted(
          "materialized outreach sequences",
          sequences.length,
          campaignContacts.length,
        );

        const events = await tx.outreachEvent.createMany({
          data: sequences.map((sequence) => ({
            sequenceId: sequence.id,
            type: "SMS_PENDING" as const,
            channel: "SMS" as const,
            resultingState: "SMS_PENDING" as const,
            occurredAt: sequence.createdAt,
            source: "campaign_import",
            idempotencyKey: `sms-sequence:${sequence.campaignContactId}:created`,
          })),
        });
        assertInserted("outreach events", events.count, sequences.length);
      } while (cursor);

      const committedBatch = await tx.importBatch.updateMany({
        where: {
          id: batch.id,
          status: "ANALYZED",
          campaignId: null,
        },
        data: {
          campaignId: campaign.id,
          status: "COMMITTED",
          committedAt: new Date(),
        },
      });
      if (committedBatch.count !== 1) throw new ImportCommitConflictError();

      await tx.campaign.update({
        where: { id: campaign.id },
        data: { status: "DATA_READY" },
      });

      return { campaignId: campaign.id };
    },
    { maxWait: 15_000, timeout: IMPORT_COMMIT_TIMEOUT_MS },
  );
}
