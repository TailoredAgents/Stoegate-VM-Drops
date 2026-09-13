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
      9,
      "Estimated Drop Cowboy cost per delivered drop",
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
