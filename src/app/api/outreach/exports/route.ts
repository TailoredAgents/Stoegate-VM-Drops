import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { createOutreachExport } from "@/lib/outreach-exports";
import { assertSameOrigin } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";

const schema = z.object({
  type: z.literal("BATCH_DIALER"),
  campaignId: z.uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  source: z.string().trim().max(200).optional(),
  state: z.string().trim().max(100).optional(),
  county: z.string().trim().max(200).optional(),
  idempotencyKey: z.uuid(),
  intentionalRepeat: z.boolean().optional(),
  repeatReason: z.string().trim().max(500).optional(),
  confirmation: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const user = await requireApiUser();
    assertSameOrigin(request);
    if (user.role !== "ADMIN") return jsonError("Admin access required", 403);
    const input = schema.parse(await request.json());
    const result = await createOutreachExport({ ...input, user });
    return Response.json({
      exportId: result.id,
      filename: result.filename,
      itemCount: result.itemCount,
      downloadUrl: `/api/outreach/exports/${result.id}/download`,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError(
      error instanceof Error ? error.message : "Could not create export",
      400,
    );
  }
}
