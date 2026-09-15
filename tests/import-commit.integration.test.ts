import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  commitSmsImport,
  ImportCommitConflictError,
} from "@/lib/import-commit";

const prefix = `import-commit-${randomUUID()}`;
let adminId = "";
let templateId = "";
let templateVersionId = "";
let phoneSeed = Number.parseInt(randomUUID().slice(0, 7), 16) % 9_000_000;

function nextPhone() {
  phoneSeed = (phoneSeed + 1) % 9_000_000;
  return `+1888${String(phoneSeed + 1_000_000).padStart(7, "0")}`;
}

function mappedRow(source: string, rowNumber: number) {
  return {
    phone: nextPhone(),
    first_name: "Import",
    last_name: `Row ${rowNumber}`,
    owner_name: `Import Row ${rowNumber}`,
    property_address: `${rowNumber} Atomicity Lane`,
    street_name: "Atomicity Lane",
    city: "Testville",
    state: "VA",
    postal_code: "22101",
    county: "Fairfax",
    acreage: "1.25",
    property_type: "House",
    source,
    external_id: `${source}-${rowNumber}`,
  };
}

async function createImportBatch(label: string, rowCount: number) {
  const source = `${prefix}-${label}`;
  const rows = Array.from({ length: rowCount }, (_, offset) => {
    const rowNumber = offset + 1;
    const mapped = mappedRow(source, rowNumber);
    return { rowNumber, mapped, phone: mapped.phone };
  });
  const batch = await db.importBatch.create({
    data: {
      fileName: `${source}.csv`,
      status: "ANALYZED",
      columnMapping: { phone: "phone" },
      uploadedCount: rowCount,
      eligibleCount: rowCount,
      rows: {
        createMany: {
          data: rows.map(({ rowNumber, mapped, phone }) => ({
            rowNumber,
            status: "ELIGIBLE",
            normalizedPhone: phone,
            mappedData: mapped as Prisma.InputJsonValue,
            rawData: mapped as Prisma.InputJsonValue,
          })),
        },
      },
    },
  });
  return { batch, source };
}

function commitInput(batchId: string, source: string, campaignName: string) {
  return {
    batchId,
    campaignName,
    sourceName: source,
    smsTemplateVersionId: templateVersionId,
    timezone: "America/New_York",
    scheduledFor: null,
    sendWindowStartMinutes: 9 * 60,
    sendWindowEndMinutes: 20 * 60,
    sendIntervalSeconds: 7,
    createdByUserId: adminId,
  };
}

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
  const admin = await db.user.create({
    data: {
      email: `${prefix}@example.com`,
      passwordHash: "integration-only-not-a-login",
      role: "ADMIN",
    },
  });
  adminId = admin.id;
  const template = await db.smsTemplate.create({
    data: {
      name: `${prefix}-template`,
      createdByUserId: adminId,
      versions: {
        create: {
          version: 1,
          body: "Hi {{first_name}}, are you open to an offer?",
          contentHash: `${prefix}-hash`,
          status: "APPROVED",
          createdByUserId: adminId,
          approvedByUserId: adminId,
          approvedAt: new Date(),
        },
      },
    },
    include: { versions: true },
  });
  templateId = template.id;
  templateVersionId = template.versions[0].id;
});

afterAll(async () => {
  await db.campaign.deleteMany({
    where: { sourceName: { startsWith: prefix } },
  });
  await db.importBatch.deleteMany({
    where: { fileName: { startsWith: prefix } },
  });
  await db.contact.deleteMany({ where: { source: { startsWith: prefix } } });
  await db.property.deleteMany({ where: { source: { startsWith: prefix } } });
  if (templateId) await db.smsTemplate.delete({ where: { id: templateId } });
  if (adminId) await db.user.delete({ where: { id: adminId } });
});

describe("atomic import commits", () => {
  it("allows exactly one of two concurrent commits for a batch", async () => {
    const { batch, source } = await createImportBatch("concurrent", 50);
    const results = await Promise.allSettled([
      commitSmsImport(commitInput(batch.id, source, `${source}-campaign-a`)),
      commitSmsImport(commitInput(batch.id, source, `${source}-campaign-b`)),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ImportCommitConflictError,
    );

    const committedBatch = await db.importBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(committedBatch).toMatchObject({ status: "COMMITTED" });
    expect(committedBatch.campaignId).toBe(
      (fulfilled[0] as PromiseFulfilledResult<{ campaignId: string }>).value
        .campaignId,
    );
    expect(await db.campaign.count({ where: { sourceName: source } })).toBe(1);
    expect(
      await db.campaign.findUniqueOrThrow({
        where: { id: committedBatch.campaignId! },
        select: { smsSendIntervalSeconds: true },
      }),
    ).toEqual({ smsSendIntervalSeconds: 7 });
    expect(
      await db.campaignContact.count({
        where: { campaignId: committedBatch.campaignId! },
      }),
    ).toBe(50);
    expect(
      await db.outreachSequence.count({
        where: { campaignContact: { campaignId: committedBatch.campaignId! } },
      }),
    ).toBe(50);
    expect(await db.property.count({ where: { source } })).toBe(50);
  });

  it("rolls back the first page when a later page fails", async () => {
    const { batch, source } = await createImportBatch("rollback", 501);
    const [lastRow] = await db.importRow.findMany({
      where: { importBatchId: batch.id },
      orderBy: { id: "desc" },
      take: 1,
    });
    const mapped = lastRow.mappedData as Record<string, string>;
    await db.importRow.update({
      where: { id: lastRow.id },
      data: {
        mappedData: {
          ...mapped,
          acreage: "999999999999999999999999999999",
        },
      },
    });

    await expect(
      commitSmsImport(commitInput(batch.id, source, `${source}-campaign`)),
    ).rejects.toThrow();

    expect(
      await db.importBatch.findUniqueOrThrow({ where: { id: batch.id } }),
    ).toMatchObject({ status: "ANALYZED", campaignId: null });
    expect(await db.campaign.count({ where: { sourceName: source } })).toBe(0);
    expect(
      await db.campaignContact.count({
        where: { importRow: { importBatchId: batch.id } },
      }),
    ).toBe(0);
    expect(await db.contact.count({ where: { source } })).toBe(0);
    expect(await db.property.count({ where: { source } })).toBe(0);
  });
});
