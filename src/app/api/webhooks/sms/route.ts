import { getEnv } from "@/lib/env";
import {
  parseCanonicalSmsWebhook,
  processCanonicalSmsWebhook,
} from "@/lib/sms-webhooks";
import { verifySmsWebhookSignature } from "@/lib/sms-webhook-security";
import { jsonError } from "@/lib/utils";

export async function POST(request: Request) {
  try {
    const env = getEnv();
    if (!env.SMS_PROVIDER_WEBHOOK_SECRET)
      return jsonError("SMS webhook is not configured", 503);
    const rawBody = await request.text();
    if (
      !verifySmsWebhookSignature(
        rawBody,
        request.headers.get("x-stonegate-signature"),
        env.SMS_PROVIDER_WEBHOOK_SECRET,
      )
    )
      return jsonError("Invalid SMS webhook signature", 401);

    const event = parseCanonicalSmsWebhook(rawBody);
    if (event.providerKey !== env.SMS_PROVIDER)
      return jsonError(
        "SMS webhook provider does not match configuration",
        409,
      );
    return Response.json(await processCanonicalSmsWebhook(event));
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Could not process SMS webhook",
      400,
    );
  }
}
