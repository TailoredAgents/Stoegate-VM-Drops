import { requireApiUser } from "@/lib/auth";
import { getOutreachExportCsv } from "@/lib/outreach-exports";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiUser();
    const result = await getOutreachExportCsv((await params).id);
    if (!result) return jsonError("Export not found", 404);
    return new Response(result.csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${result.filename.replaceAll('"', "")}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError("Could not download export", 400);
  }
}
