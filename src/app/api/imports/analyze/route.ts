import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  analyzeImportRows,
  parseImportFile,
  summarizeImport,
} from "@/lib/imports";
import { assertSameOrigin } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";

const mappingSchema = z.record(z.string(), z.string());

export async function POST(request: Request) {
  try {
    await requireApiUser();
    assertSameOrigin(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      return jsonError("A CSV or XLSX file is required");
    if (file.size > 25 * 1024 * 1024)
      return jsonError("File exceeds the 25 MB limit", 413);
    const mapping = mappingSchema.parse(
      JSON.parse(String(form.get("mapping") ?? "{}")),
    );
    if (!mapping.phone)
      return jsonError("Map a source column to phone before analyzing");
    const sourceRows = await parseImportFile(
      file.name,
      Buffer.from(await file.arrayBuffer()),
    );
    const possiblePhones = sourceRows
      .map((row) => row[mapping.phone!] ?? "")
      .filter(Boolean);
    const { normalizeUSPhone } = await import("@/lib/phone");
    const normalized = [
      ...new Set(
        possiblePhones
          .map(normalizeUSPhone)
          .filter((phone): phone is string => Boolean(phone)),
      ),
    ];
    const suppressions = await db.suppressionEntry.findMany({
      where: { normalizedPhone: { in: normalized } },
      select: { normalizedPhone: true },
    });
    const analyzed = analyzeImportRows(
      sourceRows,
      mapping,
      new Set(suppressions.map((row) => row.normalizedPhone)),
    );
    const summary = summarizeImport(analyzed);
    const batch = await db.importBatch.create({
      data: {
        fileName: file.name,
        status: "ANALYZED",
        columnMapping: mapping,
        uploadedCount: summary.uploaded,
        eligibleCount: summary.eligible,
        invalidCount: summary.invalid + summary.missing,
        duplicateCount: summary.duplicate,
        suppressedCount: summary.suppressed,
        missingCount: summary.missing,
      },
    });
    for (let offset = 0; offset < analyzed.length; offset += 500) {
      await db.importRow.createMany({
        data: analyzed.slice(offset, offset + 500).map((row) => ({
          importBatchId: batch.id,
          rowNumber: row.rowNumber,
          status: row.status,
          normalizedPhone: row.normalizedPhone,
          mappedData: row.mappedData as Prisma.InputJsonValue,
          rawData: row.rawData as Prisma.InputJsonValue,
          errorMessage: row.errorMessage,
        })),
      });
    }
    return Response.json({
      batchId: batch.id,
      summary,
      sampleIssues: analyzed
        .filter((row) => row.status !== "ELIGIBLE")
        .slice(0, 20),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError(
      error instanceof Error ? error.message : "Could not analyze import",
    );
  }
}
