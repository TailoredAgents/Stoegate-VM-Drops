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
import { MAX_SMS_SEND_INTERVAL_SECONDS } from "@/lib/sms-pacing";
import { reconcileTwilioMessageCosts } from "@/lib/twilio-cost-reconciliation";
import {
  acknowledgeTwilioProductionApproval,
  revokeTwilioProductionApproval,
  runTwilioReadinessDiagnostic,
} from "@/lib/twilio-readiness";

const integerKeys = new Set<NumericSettingKey>([
  "sms_provider_fixed_monthly_fee_cents",
  "sms_cost_per_outbound_message_micros",
  "sms_cost_per_segment_micros",
  "sms_carrier_surcharge_per_outbound_segment_micros",
  "sms_cost_per_inbound_message_micros",
  "sms_phone_number_monthly_cents",
  "sms_registration_monthly_cents",
  "sms_to_cold_call_delay_hours",
  "sms_send_interval_seconds",
  "daily_sms_cap",
  "provider_billing_cycle_day",
  "infrastructure_monthly_overhead_cents",
]);

const positiveKeys = new Set<NumericSettingKey>([
  "sms_to_cold_call_delay_hours",
  "sms_send_interval_seconds",
  "daily_sms_cap",
  "provider_billing_cycle_day",
  "va_real_conversations_per_hour",
  "va_real_conversations_per_lead",
  "va_leads_per_deal",
]);

export async function updateSettingsAction(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new Error("Admin access required");

  const values = new Map<string, string | number>();
  for (const key of Object.keys(NUMERIC_SETTINGS) as NumericSettingKey[]) {
    let schema = z.coerce.number().finite().nonnegative();
    if (integerKeys.has(key)) schema = schema.int();
    if (positiveKeys.has(key)) schema = schema.positive();
    const value = schema.parse(formData.get(key));
    if (key === "provider_billing_cycle_day" && value > 28)
      throw new Error("Billing cycle day must be between 1 and 28");
    if (
      key === "sms_send_interval_seconds" &&
      value > MAX_SMS_SEND_INTERVAL_SECONDS
    ) {
      throw new Error(
        `SMS send interval must be between 1 and ${MAX_SMS_SEND_INTERVAL_SECONDS} seconds`,
      );
    }
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
    !isValidLocalTime(text.sms_send_window_start) ||
    !isValidLocalTime(text.sms_send_window_end)
  )
    throw new Error("SMS send-window values must use HH:MM");
  if (Boolean(text.sms_send_window_start) !== Boolean(text.sms_send_window_end))
    throw new Error("Set both SMS send-window times or leave both blank");
  if (!text.sms_provider_display_name)
    throw new Error("Provider display name is required");
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
  revalidatePath("/operations");
  revalidatePath("/campaigns/new");
}

async function requireAdmin() {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new Error("Admin access required");
  return user;
}

export async function runTwilioDiagnosticAction() {
  const user = await requireAdmin();
  await runTwilioReadinessDiagnostic({ actorUserId: user.id });
  revalidatePath("/settings");
}

export async function acknowledgeTwilioProductionApprovalAction() {
  const user = await requireAdmin();
  await acknowledgeTwilioProductionApproval({ actorUserId: user.id });
  revalidatePath("/settings");
}

export async function revokeTwilioProductionApprovalAction() {
  const user = await requireAdmin();
  await revokeTwilioProductionApproval({ actorUserId: user.id });
  revalidatePath("/settings");
}

export async function reconcileTwilioCostsAction() {
  const user = await requireAdmin();
  await reconcileTwilioMessageCosts({ actorUserId: user.id, limit: 25 });
  revalidatePath("/settings");
  revalidatePath("/operations");
  revalidatePath("/dashboard");
}
