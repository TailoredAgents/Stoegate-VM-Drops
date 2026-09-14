import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

export const NUMERIC_SETTINGS = {
  sms_provider_fixed_monthly_fee_cents: 0,
  sms_cost_per_outbound_message_micros: 0,
  sms_cost_per_segment_micros: 0,
  sms_cost_per_inbound_message_micros: 0,
  sms_phone_number_monthly_cents: 0,
  sms_registration_monthly_cents: 0,
  sms_to_cold_call_delay_hours: 48,
  daily_sms_cap: 2000,
  provider_billing_cycle_day: 1,
  infrastructure_monthly_overhead_cents: 0,
  va_hourly_rate_cents: 700,
  va_real_conversations_per_hour: 6,
  va_real_conversations_per_lead: 40,
  va_leads_per_deal: 15,
} as const;

export const TEXT_SETTINGS = {
  operations_timezone: "America/New_York",
  sms_send_window_start: "09:00",
  sms_send_window_end: "20:00",
  sms_provider_display_name: "Not selected",
  sms_sender_identification: "",
  sms_compliance_notes: "",
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
  "daily_sms_cap",
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
