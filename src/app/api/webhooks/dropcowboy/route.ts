import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { jsonError } from "@/lib/utils";
import {
  processDropCowboyWebhook,
  verifyDropCowboySignature,
} from "@/lib/webhooks";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature =
    request.headers.get("x-dropcowboy-signature") ??
    request.headers.get("x-dc-signature");
  const secret = getEnv().DROP_COWBOY_WEBHOOK_SECRET;
  if (!secret) return jsonError("Drop Cowboy webhook is not configured", 503);
  if (!verifyDropCowboySignature(rawBody, signature, secret))
    return jsonError("Invalid signature", 401);
  try {
    const result = await processDropCowboyWebhook(JSON.parse(rawBody));
    logger.info(
      { webhookEventId: result.eventId, duplicate: result.duplicate },
      "Drop Cowboy webhook processed",
    );
    return Response.json({ ok: true, duplicate: result.duplicate });
  } catch (error) {
    logger.warn({ error }, "Drop Cowboy webhook rejected");
    return jsonError(
      error instanceof Error ? error.message : "Invalid webhook",
      400,
    );
  }
}
