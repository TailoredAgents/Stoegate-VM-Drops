"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { DEFAULT_SETTINGS } from "@/lib/settings";

export async function updateSettingsAction(formData: FormData) {
  await requireUser();
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<
    keyof typeof DEFAULT_SETTINGS
  >) {
    const value = (
      key.startsWith("va_real_") || key === "va_leads_per_deal"
        ? z.coerce.number().positive()
        : z.coerce.number().nonnegative()
    ).parse(formData.get(key));
    await db.appSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
  revalidatePath("/settings");
}
