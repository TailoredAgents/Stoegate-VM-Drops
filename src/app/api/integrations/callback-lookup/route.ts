import { getEnv } from "@/lib/env";
import {
  lookupCallback,
  serializeCallbackCandidate,
} from "@/lib/callback-matching";
import { normalizeUSPhone } from "@/lib/phone";
import { verifyIntegrationKey } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!verifyIntegrationKey(request)) return jsonError("Unauthorized", 401);
  const phone = normalizeUSPhone(
    new URL(request.url).searchParams.get("phone"),
  );
  if (!phone) return jsonError("A valid US phone number is required");
  const match = await lookupCallback(phone, getEnv().CALLBACK_LOOKBACK_DAYS);
  if (match.status === "not_found")
    return Response.json({ match_status: "not_found", phone });
  if (match.status === "ambiguous") {
    return Response.json({
      match_status: "ambiguous",
      phone,
      candidates: match.candidates.map(serializeCallbackCandidate),
    });
  }
  return Response.json({
    match_status: "matched",
    ...serializeCallbackCandidate(match.candidate),
  });
}
