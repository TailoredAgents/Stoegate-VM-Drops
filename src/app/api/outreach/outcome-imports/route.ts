import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import {
  getColdCallOutcomePreviewToken,
  importColdCallOutcomes,
  previewColdCallOutcomes,
} from "@/lib/outcome-imports";
import { assertSameOrigin } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";

export async function POST(request: Request) {
  try {
    const user = await requireApiUser();
    assertSameOrigin(request);
    if (user.role !== "ADMIN") return jsonError("Admin access required", 403);

    const form = await request.formData();
    const file = form.get("file");
    const requestedChannel = form.get("channel");
    if (
      requestedChannel !== null &&
      requestedChannel !== "" &&
      requestedChannel !== "COLD_CALL"
    )
      return jsonError("Only COLD_CALL outcome imports are supported", 400);
    const action = z.enum(["preview", "commit"]).parse(form.get("action"));
    if (!(file instanceof File)) return jsonError("CSV file is required", 400);
    if (!file.name.toLowerCase().endsWith(".csv"))
      return jsonError("Outcome imports must be CSV files", 400);
    if (file.size > 5 * 1024 * 1024)
      return jsonError("Outcome CSV is limited to 5 MB", 400);

    const bytes = Buffer.from(await file.arrayBuffer());
    if (action === "preview")
      return Response.json(await previewColdCallOutcomes({ bytes }));

    const previewToken = z.string().length(64).parse(form.get("previewToken"));
    if (previewToken !== getColdCallOutcomePreviewToken(bytes))
      return jsonError("The file changed after preview", 409);
    const preview = await previewColdCallOutcomes({ bytes });
    const confirmation = z.string().parse(form.get("confirmation"));
    if (confirmation !== preview.confirmation)
      return jsonError(`Type ${preview.confirmation} to confirm this import`);

    return Response.json(
      await importColdCallOutcomes({
        fileName: file.name,
        bytes,
        userId: user.id,
        previewToken,
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError(
      error instanceof Error ? error.message : "Could not import outcomes",
      400,
    );
  }
}
