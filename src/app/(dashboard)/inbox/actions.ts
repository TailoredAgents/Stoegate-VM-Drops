"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import {
  classifySmsInboundMessage,
  SMS_INBOUND_CLASSIFICATIONS,
} from "@/lib/sms-conversations";

const classificationSchema = z.object({
  messageId: z.uuid(),
  classification: z.enum(SMS_INBOUND_CLASSIFICATIONS),
});

export async function classifySmsInboundMessageAction(formData: FormData) {
  const user = await requireUser();
  const input = classificationSchema.parse(Object.fromEntries(formData));
  await classifySmsInboundMessage({
    messageId: input.messageId,
    classification: input.classification,
    actorUserId: user.id,
  });
  revalidatePath("/inbox");
}
