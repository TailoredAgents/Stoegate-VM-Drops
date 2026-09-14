"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { normalizeUSPhone } from "@/lib/phone";
import { suppressPhoneGlobally } from "@/lib/suppression";

export async function addSuppressionAction(formData: FormData) {
  const user = await requireUser();
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
  await suppressPhoneGlobally({
    normalizedPhone,
    reason: input.reason,
    notes: input.notes,
    source: "manual",
    actorUserId: user.id,
  });
  revalidatePath("/suppression");
  revalidatePath("/inbox");
  revalidatePath("/operations");
}
