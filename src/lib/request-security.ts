import { getEnv } from "@/lib/env";

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const expected = new URL(getEnv().APP_BASE_URL).origin;
  if (origin !== expected) throw new Error("INVALID_ORIGIN");
}
