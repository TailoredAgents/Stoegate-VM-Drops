import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

export const NUMERIC_SETTINGS = {
  elevenlabs_cost_per_1000_chars_cents: 30,
  rvm_cost_per_delivered_drop_cents: 9,
  compliance_cost_per_message_cents: 0,
  rvm_to_sms_delay_hours: 24,
  sms_to_cold_call_delay_hours: 48,
  daily_rvm_cap: 2000,
  provider_billing_cycle_day: 1,
  drop_cowboy_monthly_minimum_cents: 25_000,
  drop_cowboy_success_cost_cents: 1,
  carrier_trunk_monthly_cents: 1_500,
  carrier_did_monthly_cents: 115,
  carrier_active_did_count: 1,
  carrier_voice_cents_per_minute: 0.66,
  carrier_average_seconds_per_attempt: 30,
  infrastructure_monthly_overhead_cents: 0,
  va_hourly_rate_cents: 700,
  va_real_conversations_per_hour: 6,
  va_real_conversations_per_lead: 40,
  va_leads_per_deal: 15,
} as const;

export const TEXT_SETTINGS = {
  operations_timezone: "America/New_York",
  rvm_send_window_start: "",
  rvm_send_window_end: "",
  carrier_provider_name: "Twilio",
} as const;

export const DEFAULT_SETTINGS = {
  ...NUMERIC_SETTINGS,
  ...TEXT_SETTINGS,
} as const;

export type NumericSettingKey = keyof typeof NUMERIC_SETTINGS;
export type TextSettingKey = keyof typeof TEXT_SETTINGS;
export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type AppSettings = {
  [Key in SettingKey]: (typeof DEFAULT_SETTINGS)[Key] extends number
    ? number
    : string;
};

type SettingsClient = PrismaClient | Prisma.TransactionClient;

const positiveNumericSettings = new Set<NumericSettingKey>([
  "daily_rvm_cap",
  "provider_billing_cycle_day",
  "va_real_conversations_per_hour",
  "va_real_conversations_per_lead",
  "va_leads_per_deal",
]);

export async function getAppSettings(
  client: SettingsClient = db,
): Promise<AppSettings> {
  const records = await client.appSetting.findMany({
    where: { key: { in: Object.keys(DEFAULT_SETTINGS) } },
  });
  const result: Record<string, number | string> = { ...DEFAULT_SETTINGS };
  for (const record of records) {
    if (!(record.key in DEFAULT_SETTINGS)) continue;
    const defaultValue = DEFAULT_SETTINGS[record.key as SettingKey];
    if (
      typeof defaultValue === "number" &&
      typeof record.value === "number" &&
      Number.isFinite(record.value) &&
      (!positiveNumericSettings.has(record.key as NumericSettingKey) ||
        record.value > 0)
    ) {
      result[record.key] = record.value;
    } else if (
      typeof defaultValue === "string" &&
      typeof record.value === "string"
    ) {
      result[record.key] = record.value;
    }
  }
  return result as AppSettings;
}

export async function getNumericSettings(client: SettingsClient = db) {
  const settings = await getAppSettings(client);
  return Object.fromEntries(
    Object.keys(NUMERIC_SETTINGS).map((key) => [
      key,
      settings[key as NumericSettingKey],
    ]),
  ) as Record<NumericSettingKey, number>;
}

export function isValidIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function isValidLocalTime(value: string): boolean {
  return value === "" || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
