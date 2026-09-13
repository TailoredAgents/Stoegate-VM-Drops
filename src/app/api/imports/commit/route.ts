import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import type { CanonicalField } from "@/lib/import-fields";
import { assertSameOrigin } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";

const bodySchema = z.object({
  batchId: z.uuid(),
  campaignName: z.string().trim().min(2).max(120),
  scriptTemplateVersionId: z.uuid(),
  voiceConfigurationId: z.uuid(),
  sendLimit: z.number().int().min(1).max(100000).optional(),
});

type Mapped = Record<CanonicalField, string>;

export async function POST(request: Request) {
  try {
    await requireApiUser();
    assertSameOrigin(request);
    const input = bodySchema.parse(await request.json());
    const batch = await db.importBatch.findUniqueOrThrow({
      where: { id: input.batchId },
    });
    if (batch.status !== "ANALYZED" || batch.campaignId)
      return jsonError("Import batch has already been committed", 409);
    const sendLimit = input.sendLimit ?? getEnv().DEFAULT_CAMPAIGN_SEND_LIMIT;
    const campaign = await db.campaign.create({
      data: {
        name: input.campaignName,
        status: "DRAFT",
        sendLimit,
        uploadedCount: batch.uploadedCount,
        eligibleCount: batch.eligibleCount,
        invalidCount: batch.invalidCount,
        duplicateCount: batch.duplicateCount,
        suppressedCount: batch.suppressedCount,
        scriptTemplateVersionId: input.scriptTemplateVersionId,
        voiceConfigurationId: input.voiceConfigurationId,
      },
    });
    let cursor: string | undefined;
    do {
      const rows = await db.importRow.findMany({
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
      for (const row of rows)
        if (!firstByPhone.has(row.normalizedPhone!))
          firstByPhone.set(row.normalizedPhone!, {
            mapped: row.mappedData as Mapped,
            raw: row.rawData,
          });
      await db.contact.createMany({
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
      const contacts = await db.contact.findMany({
        where: { normalizedPhone: { in: phones } },
        select: { id: true, normalizedPhone: true },
      });
      const contactByPhone = new Map(
        contacts.map((contact) => [contact.normalizedPhone, contact.id]),
      );
      const prepared = rows.map((row) => {
        const mapped = row.mappedData as Mapped;
        const propertyId = randomUUID();
        return {
          row,
          mapped,
          propertyId,
          contactId: contactByPhone.get(row.normalizedPhone!)!,
        };
      });
      await db.$transaction([
        db.property.createMany({
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
        }),
        db.contactProperty.createMany({
          data: prepared.map(({ contactId, propertyId }) => ({
            contactId,
            propertyId,
          })),
          skipDuplicates: true,
        }),
        db.campaignContact.createMany({
          data: prepared.map(({ row, contactId, propertyId }) => ({
            campaignId: campaign.id,
            contactId,
            propertyId,
            importRowId: row.id,
          })),
          skipDuplicates: true,
        }),
      ]);
    } while (cursor);
    await db.$transaction([
      db.importBatch.update({
        where: { id: batch.id },
        data: {
          campaignId: campaign.id,
          status: "COMMITTED",
          committedAt: new Date(),
        },
      }),
      db.campaign.update({
        where: { id: campaign.id },
        data: { status: "DATA_READY" },
      }),
    ]);
    return Response.json({ campaignId: campaign.id });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError(
      error instanceof Error ? error.message : "Could not commit campaign",
    );
  }
}
