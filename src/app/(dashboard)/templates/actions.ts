"use server";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { validateSmsTemplate } from "@/lib/sms";
import { sha256 } from "@/lib/utils";

const bodySchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .pipe(z.string().min(1).max(5_000));

function validatedBody(value: unknown) {
  const body = bodySchema.parse(value);
  const validation = validateSmsTemplate(body);
  if (!validation.valid) throw new Error(validation.error);
  return body;
}

function templateHash(body: string) {
  return sha256(body);
}

async function withSerializableRetry<T>(work: () => Promise<T>) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (
        attempt < 3 &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      )
        continue;
      throw error;
    }
  }
  throw new Error("The template could not be saved");
}

export async function createSmsTemplateAction(formData: FormData) {
  const user = await requireUser();
  const input = z
    .object({
      name: z.string().trim().min(2).max(120),
      description: z.string().trim().max(500).optional(),
      body: z.unknown(),
    })
    .parse(Object.fromEntries(formData));
  const body = validatedBody(input.body);
  await db.smsTemplate.create({
    data: {
      name: input.name,
      description: input.description || null,
      createdByUserId: user.id,
      versions: {
        create: {
          version: 1,
          body,
          contentHash: templateHash(body),
          createdByUserId: user.id,
        },
      },
    },
  });
  revalidatePath("/templates");
}

export async function createSmsTemplateVersionAction(formData: FormData) {
  const user = await requireUser();
  const input = z
    .object({ templateId: z.uuid(), body: z.unknown() })
    .parse(Object.fromEntries(formData));
  const body = validatedBody(input.body);
  const contentHash = templateHash(body);

  await withSerializableRetry(() =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${`sms-template:${input.templateId}`})
          )::text AS locked
        `;
        const template = await tx.smsTemplate.findUnique({
          where: { id: input.templateId },
          select: { id: true, active: true },
        });
        if (!template) throw new Error("SMS template not found");
        if (!template.active) throw new Error("This SMS template is inactive");
        const duplicate = await tx.smsTemplateVersion.findFirst({
          where: { templateId: template.id, contentHash },
          select: { version: true },
        });
        if (duplicate)
          throw new Error(
            `This content already exists as version ${duplicate.version}`,
          );
        const latest = await tx.smsTemplateVersion.aggregate({
          where: { templateId: template.id },
          _max: { version: true },
        });
        await tx.smsTemplateVersion.create({
          data: {
            templateId: template.id,
            version: (latest._max.version ?? 0) + 1,
            body,
            contentHash,
            createdByUserId: user.id,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    ),
  );
  revalidatePath("/templates");
}

export async function approveSmsTemplateVersionAction(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new Error("Admin access required");
  const { versionId } = z
    .object({ versionId: z.uuid() })
    .parse(Object.fromEntries(formData));
  const lockTarget = await db.smsTemplateVersion.findUnique({
    where: { id: versionId },
    select: { templateId: true },
  });
  if (!lockTarget) throw new Error("SMS template version not found");

  await withSerializableRetry(() =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${`sms-template:${lockTarget.templateId}`})
          )::text AS locked
        `;
        const version = await tx.smsTemplateVersion.findUnique({
          where: { id: versionId },
        });
        if (!version) throw new Error("SMS template version not found");
        if (version.status === "RETIRED")
          throw new Error("A retired version cannot be approved");
        const body = validatedBody(version.body);
        if (templateHash(body) !== version.contentHash)
          throw new Error(
            "Template content hash does not match its stored body",
          );
        if (version.status === "APPROVED") return;
        const now = new Date();
        await tx.smsTemplateVersion.update({
          where: { id: version.id },
          data: {
            status: "APPROVED",
            approvedAt: now,
            approvedByUserId: user.id,
            retiredAt: null,
          },
        });
        await tx.smsAuditEvent.create({
          data: {
            eventType: "SMS_TEMPLATE_VERSION_APPROVED",
            entityType: "SmsTemplateVersion",
            entityId: version.id,
            actorUserId: user.id,
            idempotencyKey: `sms-template-approval:${version.id}:${randomUUID()}`,
            source: "templates_ui",
            before: { status: version.status },
            after: { status: "APPROVED" },
            occurredAt: now,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    ),
  );
  revalidatePath("/templates");
}

export async function retireSmsTemplateVersionAction(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new Error("Admin access required");
  const { versionId } = z
    .object({ versionId: z.uuid() })
    .parse(Object.fromEntries(formData));
  const lockTarget = await db.smsTemplateVersion.findUnique({
    where: { id: versionId },
    select: { templateId: true },
  });
  if (!lockTarget) throw new Error("SMS template version not found");

  await withSerializableRetry(() =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${`sms-template:${lockTarget.templateId}`})
          )::text AS locked
        `;
        const version = await tx.smsTemplateVersion.findUnique({
          where: { id: versionId },
        });
        if (!version) throw new Error("SMS template version not found");
        if (version.status === "RETIRED") return;
        const activeCampaigns = await tx.campaign.count({
          where: {
            kind: "SMS",
            smsTemplateVersionId: version.id,
            status: { notIn: ["COMPLETED", "FAILED"] },
          },
        });
        if (activeCampaigns)
          throw new Error(
            "This template version is still assigned to an active campaign",
          );
        const now = new Date();
        await tx.smsTemplateVersion.update({
          where: { id: version.id },
          data: { status: "RETIRED", retiredAt: now },
        });
        await tx.smsAuditEvent.create({
          data: {
            eventType: "SMS_TEMPLATE_VERSION_RETIRED",
            entityType: "SmsTemplateVersion",
            entityId: version.id,
            actorUserId: user.id,
            idempotencyKey: `sms-template-retirement:${version.id}:${randomUUID()}`,
            source: "templates_ui",
            before: { status: version.status },
            after: { status: "RETIRED" },
            occurredAt: now,
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      },
    ),
  );
  revalidatePath("/templates");
}
