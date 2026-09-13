import { requireApiUser } from "@/lib/auth";
import { parseImportFile, suggestColumnMapping } from "@/lib/imports";
import { assertSameOrigin } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";

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
    const rows = await parseImportFile(
      file.name,
      Buffer.from(await file.arrayBuffer()),
    );
    if (!rows.length) return jsonError("The file has no data rows");
    if (rows.length > 100_000)
      return jsonError("Imports are limited to 100,000 rows", 413);
    const headers = Object.keys(rows[0]);
    return Response.json({
      fileName: file.name,
      rowCount: rows.length,
      headers,
      suggestedMapping: suggestColumnMapping(headers),
      sample: rows.slice(0, 5),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError(
      error instanceof Error ? error.message : "Could not inspect import",
    );
  }
}
