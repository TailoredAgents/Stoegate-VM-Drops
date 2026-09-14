import { z } from "zod";
import { requireApiUser } from "@/lib/auth";
import {
  commitSmsImport,
  ImportCommitConflictError,
  InactiveSmsTemplateVersionError,
} from "@/lib/import-commit";
import { assertSameOrigin } from "@/lib/request-security";
import { isValidIanaTimezone } from "@/lib/settings";
import { zonedDateTimeToUtc } from "@/lib/time";
import { jsonError } from "@/lib/utils";

const localDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const localTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const bodySchema = z.object({
  batchId: z.uuid(),
  campaignName: z.string().trim().min(2).max(120),
  sourceName: z.string().trim().max(200).optional(),
  smsTemplateVersionId: z.uuid(),
  sendLimit: z.number().int().min(1).max(100_000).optional(),
  dailySendCap: z.number().int().min(1).max(100_000).optional(),
  timezone: z.string().trim().min(1).max(100),
  scheduledLocal: z.string().regex(localDateTime).optional(),
  sendWindowStart: z.string().regex(localTime),
  sendWindowEnd: z.string().regex(localTime),
  coldCallDelayHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  complianceNotes: z.string().trim().max(2_000).optional(),
});

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function scheduledInstant(value: string | undefined, timezone: string) {
  if (!value) return null;
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return zonedDateTimeToUtc({ year, month, day, hour, minute }, timezone);
}

export async function POST(request: Request) {
  try {
    const user = await requireApiUser();
    if (user.role !== "ADMIN") return jsonError("Admin access required", 403);
    assertSameOrigin(request);
    const input = bodySchema.parse(await request.json());
    if (!isValidIanaTimezone(input.timezone))
      return jsonError("Timezone must be a valid IANA timezone", 400);
    if (input.sendWindowStart === input.sendWindowEnd)
      return jsonError("SMS send-window start and end must differ", 400);
    const result = await commitSmsImport({
      ...input,
      scheduledFor: scheduledInstant(input.scheduledLocal, input.timezone),
      sendWindowStartMinutes: minutes(input.sendWindowStart),
      sendWindowEndMinutes: minutes(input.sendWindowEnd),
      createdByUserId: user.id,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED")
      return jsonError("Unauthorized", 401);
    if (error instanceof ImportCommitConflictError)
      return jsonError(error.message, 409);
    if (error instanceof InactiveSmsTemplateVersionError)
      return jsonError(error.message, 400);
    return jsonError(
      error instanceof Error ? error.message : "Could not commit SMS campaign",
    );
  }
}
