import { requireApiUser } from "@/lib/auth";
import { getProviderHealth } from "@/lib/provider-health";
import { jsonError } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireApiUser();
    if (user.role !== "ADMIN") return jsonError("Admin access required", 403);
    return Response.json({
      checks: await getProviderHealth(),
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError("Provider diagnostics failed", 500);
  }
}
