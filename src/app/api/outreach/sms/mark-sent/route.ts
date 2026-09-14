import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { recordExternalOutcomeTx } from "@/lib/outreach-service";
import { assertSameOrigin } from "@/lib/request-security";
import { jsonError } from "@/lib/utils";

const schema = z.object({
  sequenceIds: z
    .array(z.uuid())
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Sequence IDs must be unique",
    }),
  sentAt: z.iso.datetime().optional(),
  externalId: z.string().trim().max(200).optional(),
  idempotencyKey: z.uuid(),
});

export async function POST(request: Request) {
  try {
    const user = await requireApiUser();
    assertSameOrigin(request);
    if (user.role !== "ADMIN") return jsonError("Admin access required", 403);
    const input = schema.parse(await request.json());
    const occurredAt = input.sentAt ? new Date(input.sentAt) : new Date();
    await db.$transaction(
      async (tx) => {
        if (input.externalId && input.sequenceIds.length > 1)
          throw new Error(
            "A single external ID cannot be assigned to multiple SMS records",
          );
        const eligible = await tx.outreachSequence.count({
          where: {
            id: { in: input.sequenceIds },
            terminalAt: null,
            currentState: { in: ["SMS_ELIGIBLE", "SMS_EXPORTED"] },
          },
        });
        if (eligible !== input.sequenceIds.length)
          throw new Error(
            "Every SMS record must still be eligible or exported and not already marked sent",
          );
        for (const sequenceId of input.sequenceIds) {
          await recordExternalOutcomeTx(tx, {
            sequenceId,
            channel: "SMS",
            result: "sent",
            occurredAt,
            idempotencyKey: `${input.idempotencyKey}:${sequenceId}`,
            externalId: input.externalId,
            actorUserId: user.id,
          });
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 30_000,
      },
    );
    return Response.json({ ok: true, updated: input.sequenceIds.length });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    return jsonError(
      error instanceof Error ? error.message : "Could not record SMS sends",
      400,
    );
  }
}
