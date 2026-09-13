import { recordCallbackOutcome } from "@/lib/callback-outcomes";
import { verifyIntegrationKey } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";

export async function POST(request: Request) {
  if (!verifyIntegrationKey(request)) return jsonError("Unauthorized", 401);
  try {
    const { result, duplicate } = await recordCallbackOutcome(
      await request.json(),
    );
    return Response.json({
      ok: true,
      callback_outcome_id: result.id,
      duplicate,
    });
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Invalid callback result",
    );
  }
}
