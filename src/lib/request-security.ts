import { getEnv } from "@/lib/env";
import { safeEqual } from "@/lib/utils";

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const expected = new URL(getEnv().APP_BASE_URL).origin;
  if (origin !== expected) throw new Error("INVALID_ORIGIN");
}

export function verifyIntegrationKey(request: Request): boolean {
  const header = request.headers.get("authorization");
  const raw = header?.startsWith("Bearer ")
    ? header.slice(7)
    : request.headers.get("x-api-key");
  return Boolean(raw && safeEqual(raw, getEnv().STONEGATE_INTEGRATION_API_KEY));
}
