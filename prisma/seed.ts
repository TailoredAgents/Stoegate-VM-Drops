import { createHash } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const suppliedHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || (!suppliedHash && !password)) {
    throw new Error(
      "Set ADMIN_EMAIL and either ADMIN_PASSWORD_HASH or ADMIN_PASSWORD before seeding",
    );
  }
  const passwordHash = suppliedHash || (await hash(password!, 12));
  const admin = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, role: "ADMIN" },
    update: { passwordHash, role: "ADMIN", active: true },
  });

  const defaults: Array<[string, string | number, string]> = [
    [
      "sms_provider_fixed_monthly_fee_cents",
      0,
      "Editable SMS provider fixed monthly fee in cents",
    ],
    [
      "sms_cost_per_outbound_message_micros",
      0,
      "Estimated provider cost per outbound SMS in USD micros",
    ],
    [
      "sms_cost_per_segment_micros",
      0,
      "Estimated provider cost per SMS segment in USD micros",
    ],
    [
      "sms_carrier_surcharge_per_outbound_segment_micros",
      0,
      "Estimated carrier surcharge per outbound SMS segment in USD micros",
    ],
    [
      "sms_cost_per_inbound_message_micros",
      0,
      "Estimated provider cost per inbound SMS in USD micros",
    ],
    [
      "sms_phone_number_monthly_cents",
      0,
      "Editable monthly SMS phone-number cost in cents",
    ],
    [
      "sms_registration_monthly_cents",
      0,
      "Editable monthly registration or campaign cost in cents",
    ],
    [
      "sms_to_cold_call_delay_hours",
      positiveInteger(process.env.DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS, 48),
      "Elapsed hours after a confirmed SMS send before cold-call eligibility",
    ],
    [
      "daily_sms_cap",
      positiveInteger(process.env.DEFAULT_DAILY_SMS_LIMIT, 2000),
      "Global local-day SMS attempt operating cap",
    ],
    ["provider_billing_cycle_day", 1, "Provider billing-cycle start day"],
    [
      "infrastructure_monthly_overhead_cents",
      0,
      "Optional monthly infrastructure overhead",
    ],
    ["va_hourly_rate_cents", 700, "VA hourly labor rate"],
    [
      "va_real_conversations_per_hour",
      6,
      "Real homeowner conversations completed per VA hour",
    ],
    [
      "va_real_conversations_per_lead",
      40,
      "Real homeowner conversations required per qualified lead",
    ],
    ["va_leads_per_deal", 15, "Qualified leads required per deal"],
    ["operations_timezone", "America/New_York", "Operations IANA timezone"],
    [
      "sms_send_window_start",
      "09:00",
      "Default local business-day SMS send-window start in HH:MM",
    ],
    [
      "sms_send_window_end",
      "20:00",
      "Default local business-day SMS send-window end in HH:MM",
    ],
    [
      "sms_provider_display_name",
      "Twilio",
      "Operator-facing SMS provider label",
    ],
    [
      "sms_sender_identification",
      "",
      "Reviewed sender-identification wording or reference",
    ],
    [
      "sms_compliance_notes",
      "",
      "Operator-maintained provider/compliance readiness notes",
    ],
  ];
  for (const [key, value, description] of defaults) {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue, description },
      update: {},
    });
  }

  const starterBody =
    "Hi {{first_name}}, this is Stonegate Home Buyers. Would you consider an offer for {{property_address}}? Reply STOP to opt out.";
  const template = await prisma.smsTemplate.upsert({
    where: { name: "Stonegate property outreach" },
    create: {
      name: "Stonegate property outreach",
      description:
        "Starter draft only. Review sender, consent, content, and provider requirements before approval.",
      createdByUserId: admin.id,
    },
    update: {},
  });
  await prisma.smsTemplateVersion.upsert({
    where: { templateId_version: { templateId: template.id, version: 1 } },
    create: {
      templateId: template.id,
      version: 1,
      body: starterBody,
      contentHash: createHash("sha256").update(starterBody).digest("hex"),
      status: "DRAFT",
      createdByUserId: admin.id,
    },
    update: {},
  });
}

main().finally(() => prisma.$disconnect());
