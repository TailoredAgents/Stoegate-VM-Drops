import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
  await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, role: "ADMIN" },
    update: { passwordHash, active: true },
  });

  const defaults: Array<[string, unknown, string]> = [
    [
      "elevenlabs_cost_per_1000_chars_cents",
      30,
      "Estimated ElevenLabs cost per 1,000 characters",
    ],
    [
      "rvm_cost_per_delivered_drop_cents",
      1,
      "Legacy per-success estimate; monthly BYOC economics use the settings below",
    ],
    [
      "compliance_cost_per_message_cents",
      0,
      "Other provider/compliance cost per attempted message",
    ],
    ["va_hourly_rate_cents", 700, "VA hourly labor rate"],
    [
      "va_real_conversations_per_hour",
      6,
      "Real conversations completed per VA hour",
    ],
    [
      "va_real_conversations_per_lead",
      40,
      "Real conversations required per qualified lead",
    ],
    ["va_leads_per_deal", 15, "Qualified leads required per deal"],
    [
      "rvm_to_sms_delay_hours",
      24,
      "Elapsed hours after successful RVM before SMS eligibility",
    ],
    [
      "sms_to_cold_call_delay_hours",
      48,
      "Elapsed hours after an externally recorded SMS send before cold-call eligibility",
    ],
    ["daily_rvm_cap", 2000, "Editable local-day RVM operating cap"],
    ["operations_timezone", "America/New_York", "Operations IANA timezone"],
    ["rvm_send_window_start", "", "Optional local RVM send-window start"],
    ["rvm_send_window_end", "", "Optional local RVM send-window end"],
    ["provider_billing_cycle_day", 1, "Provider billing-cycle start day"],
    [
      "drop_cowboy_monthly_minimum_cents",
      25000,
      "Account-specific Drop Cowboy BYOC monthly minimum/credit",
    ],
    [
      "drop_cowboy_success_cost_cents",
      1,
      "Account-specific cost per successful RVM",
    ],
    ["carrier_provider_name", "Twilio", "Editable SIP carrier label"],
    ["carrier_trunk_monthly_cents", 1500, "Estimated SIP trunk monthly cost"],
    ["carrier_did_monthly_cents", 115, "Estimated monthly cost per DID"],
    ["carrier_active_did_count", 1, "Active RVM DID count"],
    [
      "carrier_voice_cents_per_minute",
      0.66,
      "Estimated blended carrier cents per minute",
    ],
    [
      "carrier_average_seconds_per_attempt",
      30,
      "Estimated duration when actual carrier seconds are unavailable",
    ],
    [
      "infrastructure_monthly_overhead_cents",
      0,
      "Optional monthly infrastructure overhead",
    ],
  ];
  for (const [key, value, description] of defaults) {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: value as never, description },
      update: {},
    });
  }

  const script = await prisma.scriptTemplate.upsert({
    where: { name: "Stonegate property outreach" },
    create: {
      name: "Stonegate property outreach",
      description:
        "Editable starter template with safe missing-data conditionals.",
    },
    update: {},
  });
  await prisma.scriptTemplateVersion.upsert({
    where: { templateId_version: { templateId: script.id, version: 1 } },
    create: {
      templateId: script.id,
      version: 1,
      body: "Hi {{#if first_name}}{{first_name}}{{else}}{{owner_name}}{{/if}}, this is Austin with Stonegate Home Buyers. I was reaching out{{#if street_name}} about the property on {{street_name}}{{else}}{{#if property_address}} about {{property_address}}{{/if}}{{/if}}{{#if city}} in {{city}}{{/if}}. If you would consider an offer, please give me a call back. Thanks.",
    },
    update: {},
  });

  const voiceId = process.env.ELEVENLABS_VOICE_ID || "dry-run-voice";
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
  await prisma.voiceConfiguration.upsert({
    where: { name: "Default Stonegate voice" },
    create: { name: "Default Stonegate voice", voiceId, modelId },
    update: { voiceId, modelId },
  });
}

main().finally(() => prisma.$disconnect());
