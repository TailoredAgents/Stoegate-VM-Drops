import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    getEnv();
  } catch (error) {
    return Response.json(
      {
        status: "degraded",
        service: "stonegate-vm-drops",
        configuration: "invalid",
        error:
          error instanceof Error
            ? error.message
            : "Invalid environment configuration",
      },
      { status: 503 },
    );
  }
  try {
    await db.$queryRaw`SELECT 1`;
    return Response.json({
      status: "ok",
      service: "stonegate-vm-drops",
      database: "healthy",
    });
  } catch {
    return Response.json(
      {
        status: "degraded",
        service: "stonegate-vm-drops",
        database: "unhealthy",
      },
      { status: 503 },
    );
  }
}
