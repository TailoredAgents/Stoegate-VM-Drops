import { getEnv } from "@/lib/env";
import { DryRunSMSProvider } from "./sms-dry-run";
import { TwilioSMSProvider } from "./twilio";
import type { SMSProvider } from "./types";

let provider: SMSProvider | undefined;

export function getSmsProvider(): SMSProvider {
  if (provider) return provider;
  const env = getEnv();
  if (!env.SMS_LIVE_SENDS_ENABLED) {
    provider = new DryRunSMSProvider();
    return provider;
  }
  if (env.SMS_PROVIDER.toLowerCase() !== "twilio") {
    throw new Error(
      `No production SMS adapter is installed for provider ${env.SMS_PROVIDER}`,
    );
  }
  if (!env.TWILIO_PRODUCTION_APPROVED) {
    throw new Error(
      "TWILIO_PRODUCTION_APPROVED must be true for Twilio sending",
    );
  }
  if (
    !env.TWILIO_ACCOUNT_SID ||
    !env.TWILIO_AUTH_TOKEN ||
    !env.TWILIO_MESSAGING_SERVICE_SID
  ) {
    throw new Error("Twilio credentials are incomplete");
  }
  provider = new TwilioSMSProvider({
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    appBaseUrl: env.APP_BASE_URL,
    liveSendsEnabled: env.SMS_LIVE_SENDS_ENABLED,
    productionApproved: env.TWILIO_PRODUCTION_APPROVED,
  });
  return provider;
}
