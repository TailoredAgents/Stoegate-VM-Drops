"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateTemplate } from "@/lib/templates";

export async function createScriptAction(formData: FormData) {
  await requireUser();
  const input = z
    .object({
      name: z.string().trim().min(2).max(100),
      description: z.string().max(500).optional(),
      body: z.string().min(20).max(5000),
    })
    .parse(Object.fromEntries(formData));
  const validation = validateTemplate(input.body);
  if (!validation.valid) throw new Error(validation.error);
  await db.scriptTemplate.create({
    data: {
      name: input.name,
      description: input.description,
      versions: { create: { version: 1, body: input.body } },
    },
  });
  revalidatePath("/scripts");
}

export async function createScriptVersionAction(formData: FormData) {
  await requireUser();
  const input = z
    .object({ templateId: z.uuid(), body: z.string().min(20).max(5000) })
    .parse(Object.fromEntries(formData));
  const validation = validateTemplate(input.body);
  if (!validation.valid) throw new Error(validation.error);
  const latest = await db.scriptTemplateVersion.aggregate({
    where: { templateId: input.templateId },
    _max: { version: true },
  });
  await db.scriptTemplateVersion.create({
    data: {
      templateId: input.templateId,
      version: (latest._max.version ?? 0) + 1,
      body: input.body,
    },
  });
  revalidatePath("/scripts");
}

export async function createVoiceAction(formData: FormData) {
  await requireUser();
  const input = z
    .object({
      name: z.string().trim().min(2).max(100),
      voiceId: z.string().trim().min(2).max(200),
      modelId: z.string().trim().min(2).max(200),
    })
    .parse(Object.fromEntries(formData));
  await db.voiceConfiguration.create({ data: input });
  revalidatePath("/scripts");
}
