"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeUSPhone } from "@/lib/phone";

export async function addSuppressionAction(formData: FormData) {
  await requireUser();
  const input = z
    .object({
      phone: z.string(),
      reason: z.enum([
        "OPT_OUT",
        "MANUAL",
        "WRONG_NUMBER",
        "PROVIDER_DNC",
        "COMPLIANCE",
      ]),
      notes: z.string().max(1000).optional(),
    })
    .parse(Object.fromEntries(formData));
  const normalizedPhone = normalizeUSPhone(input.phone);
  if (!normalizedPhone) throw new Error("Enter a valid US phone number");
  const contact = await db.contact.findUnique({
    where: { normalizedPhone },
    select: { id: true },
  });
  await db.suppressionEntry.upsert({
    where: { normalizedPhone },
    create: {
      normalizedPhone,
      contactId: contact?.id,
      reason: input.reason,
      notes: input.notes,
      source: "manual",
    },
    update: { reason: input.reason, notes: input.notes },
  });
  revalidatePath("/suppression");
}
