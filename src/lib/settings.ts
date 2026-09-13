import { db } from "@/lib/db";

export const DEFAULT_SETTINGS = {
  elevenlabs_cost_per_1000_chars_cents: 30,
  rvm_cost_per_delivered_drop_cents: 9,
  compliance_cost_per_message_cents: 0,
  va_hourly_rate_cents: 700,
  va_real_conversations_per_hour: 6,
  va_real_conversations_per_lead: 40,
  va_leads_per_deal: 15,
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;

export async function getNumericSettings() {
  const records = await db.appSetting.findMany({
    where: { key: { in: Object.keys(DEFAULT_SETTINGS) } },
  });
  const result: Record<string, number> = { ...DEFAULT_SETTINGS };
  for (const record of records) {
    const mustBePositive = [
      "va_real_conversations_per_hour",
      "va_real_conversations_per_lead",
      "va_leads_per_deal",
    ].includes(record.key);
    if (
      typeof record.value === "number" &&
      Number.isFinite(record.value) &&
      (!mustBePositive || record.value > 0)
    )
      result[record.key] = record.value;
  }
  return result as Record<SettingKey, number>;
}
