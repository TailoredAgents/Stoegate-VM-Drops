import { getEnv } from "@/lib/env";
import {
  emptyTwimlResponse,
  parseTwilioInboundWebhook,
  processTwilioInboundWebhook,
  TwilioWebhookPayloadError,
  TwilioWebhookPayloadTooLargeError,
  TwilioWebhookSignatureError,
  validateTwilioWebhookRequest,
} from "@/lib/twilio-webhooks";
import { jsonError } from "@/lib/utils";

export async function POST(request: Request) {
  try {
    const env = getEnv();
    if (!env.TWILIO_AUTH_TOKEN)
      return jsonError("Twilio webhook is not configured", 503);
    const { params } = await validateTwilioWebhookRequest({
      request,
      appBaseUrl: env.APP_BASE_URL,
      authToken: env.TWILIO_AUTH_TOKEN,
    });
    const event = parseTwilioInboundWebhook(params);
    await processTwilioInboundWebhook(event);
    return emptyTwimlResponse();
  } catch (error) {
    if (error instanceof TwilioWebhookPayloadTooLargeError)
      return jsonError(error.message, 413);
    if (error instanceof TwilioWebhookSignatureError)
      return jsonError(error.message, 401);
    if (error instanceof TwilioWebhookPayloadError)
      return jsonError(error.message, 400);
    return jsonError("Could not process Twilio inbound webhook", 500);
  }
}
