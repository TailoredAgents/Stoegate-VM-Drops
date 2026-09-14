import { getEnv } from "@/lib/env";
import { DryRunSMSProvider } from "./sms-dry-run";
import type { SMSProvider } from "./types";

let provider: SMSProvider | undefined;

/**
 * Live mode deliberately has no implementation until Stonegate selects and
 * explicitly integrates a production acquisition-SMS provider.
 */
export function getSmsProvider(): SMSProvider {
  if (provider) return provider;
  const env = getEnv();
  if (!env.SMS_LIVE_SENDS_ENABLED) {
    provider = new DryRunSMSProvider();
    return provider;
  }
  throw new Error(
    `No production SMS adapter is installed for provider ${env.SMS_PROVIDER}`,
  );
}
