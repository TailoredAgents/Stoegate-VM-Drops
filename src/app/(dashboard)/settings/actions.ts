"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  isValidIanaTimezone,
  isValidLocalTime,
  NUMERIC_SETTINGS,
  TEXT_SETTINGS,
  type NumericSettingKey,
  type TextSettingKey,
} from "@/lib/settings";

const legacyKeys = new Set<NumericSettingKey>([
  "rvm_cost_per_delivered_drop_cents",
  "compliance_cost_per_message_cents",
]);

export async function updateSettingsAction(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new Error("Admin access required");
  const values = new Map<string, string | number>();
  for (const key of Object.keys(NUMERIC_SETTINGS) as NumericSettingKey[]) {
    if (legacyKeys.has(key)) continue;
    let schema = z.coerce.number().nonnegative();
    if (
      [
        "daily_rvm_cap",
        "provider_billing_cycle_day",
        "carrier_active_did_count",
      ].includes(key)
    )
      schema = schema.int();
    if (
      [
        "daily_rvm_cap",
        "provider_billing_cycle_day",
        "va_real_conversations_per_hour",
        "va_real_conversations_per_lead",
        "va_leads_per_deal",
      ].includes(key)
    )
      schema = schema.positive();
    const value = schema.parse(formData.get(key));
    if (key === "provider_billing_cycle_day" && value > 28)
      throw new Error("Billing cycle day must be between 1 and 28");
    values.set(key, value);
  }
  const text = Object.fromEntries(
    (Object.keys(TEXT_SETTINGS) as TextSettingKey[]).map((key) => [
      key,
      String(formData.get(key) ?? "").trim(),
    ]),
  ) as Record<TextSettingKey, string>;
  if (!isValidIanaTimezone(text.operations_timezone))
    throw new Error("Enter a valid IANA timezone such as America/New_York");
  if (
    !isValidLocalTime(text.rvm_send_window_start) ||
    !isValidLocalTime(text.rvm_send_window_end)
  )
    throw new Error("Send-window values must use HH:MM");
  if (Boolean(text.rvm_send_window_start) !== Boolean(text.rvm_send_window_end))
    throw new Error("Set both send-window times or leave both blank");
  if (!text.carrier_provider_name)
    throw new Error("Carrier provider name is required");
  for (const [key, value] of Object.entries(text)) values.set(key, value);
  await db.$transaction(
    [...values].map(([key, value]) =>
      db.appSetting.upsert({
        where: { key },
        create: { key, value: value as Prisma.InputJsonValue },
        update: { value: value as Prisma.InputJsonValue },
      }),
    ),
  );
  revalidatePath("/settings");
  revalidatePath("/dashboard");
  revalidatePath("/outreach");
}
