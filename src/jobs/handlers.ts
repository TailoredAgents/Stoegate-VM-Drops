import { Prisma } from "@prisma/client";
import type { Job } from "pg-boss";
import { z } from "zod";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getNumericSettings } from "@/lib/settings";
import { assertLiveSendPreconditions } from "@/lib/live-send-guards";
import { renderVoicemailTemplate } from "@/lib/templates";
import { sha256 } from "@/lib/utils";
import { getProviders } from "@/providers";
import { enqueueGenerateAudio, enqueueSendDrop } from "./queues";

const prepareSchema = z.object({
  campaignId: z.uuid(),
  mode: z.enum(["preview", "bulk"]),
});
const audioSchema = z.object({
  campaignId: z.uuid(),
  campaignContactId: z.uuid(),
  preview: z.boolean(),
});
const sendSchema = z.object({
  campaignId: z.uuid(),
  campaignContactId: z.uuid(),
  audioAssetId: z.uuid(),
});

async function recordJobStart(
  job: Job<unknown>,
  campaignId: string,
  entityId?: string,
) {
  await db.jobRun.upsert({
    where: { jobId: job.id },
    create: {
      jobId: job.id,
      queue: job.name,
      campaignId,
      entityId,
      status: "running",
      attempts: 1,
      startedAt: new Date(),
    },
    update: {
      status: "running",
      attempts: { increment: 1 },
      startedAt: new Date(),
      errorMessage: null,
    },
  });
}

async function recordJobFinish(job: Job<unknown>, error?: unknown) {
  await db.jobRun.updateMany({
    where: { jobId: job.id },
    data: {
      status: error ? "failed" : "completed",
      errorMessage:
        error instanceof Error ? error.message : error ? String(error) : null,
      finishedAt: new Date(),
    },
  });
}

export async function handlePrepareCampaign(job: Job<unknown>) {
  const data = prepareSchema.parse(job.data);
  await recordJobStart(job, data.campaignId);
  try {
    const campaign = await db.campaign.findUniqueOrThrow({
      where: { id: data.campaignId },
    });
    if (data.mode === "preview") {
      if (
        !["DATA_READY", "PREVIEW_READY", "APPROVED"].includes(campaign.status)
      ) {
        await recordJobFinish(job);
        return;
      }
      await db.campaign.update({
        where: { id: campaign.id },
        data: { status: "PREVIEW_GENERATING" },
      });
      await db.campaignContact.updateMany({
        where: { campaignId: campaign.id },
        data: { isPreview: false },
      });
      const sampleSize = Math.min(
        getEnv().PREVIEW_SAMPLE_SIZE,
        campaign.eligibleCount,
      );
      const sample = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "CampaignContact"
        WHERE "campaignId" = ${campaign.id}::uuid AND status IN ('ELIGIBLE', 'AUDIO_READY')
        ORDER BY random() LIMIT ${sampleSize}
      `;
      await db.campaignContact.updateMany({
        where: { id: { in: sample.map((row) => row.id) } },
        data: { isPreview: true },
      });
      for (const row of sample)
        await enqueueGenerateAudio(campaign.id, row.id, true);
      if (sample.length === 0)
        await db.campaign.update({
          where: { id: campaign.id },
          data: { status: "FAILED" },
        });
    } else {
      if (!["QUEUED", "SENDING"].includes(campaign.status)) {
        await recordJobFinish(job);
        return;
      }
      await db.campaign.update({
        where: { id: campaign.id },
        data: { status: "SENDING" },
      });
      const unfinished = await db.campaignContact.findMany({
        where: {
          campaignId: campaign.id,
          selectedForSend: true,
          status: { in: ["AUDIO_PENDING", "AUDIO_READY"] },
        },
        select: { id: true },
      });
      const alreadySelected = await db.campaignContact.count({
        where: { campaignId: campaign.id, selectedForSend: true },
      });
      const remaining = Math.max(0, campaign.sendLimit - alreadySelected);
      const contacts = await db.campaignContact.findMany({
        where: {
          campaignId: campaign.id,
          selectedForSend: false,
          status: { in: ["ELIGIBLE", "AUDIO_READY"] },
        },
        orderBy: { createdAt: "asc" },
        take: remaining,
        select: { id: true },
      });
      if (contacts.length) {
        await db.campaignContact.updateMany({
          where: { id: { in: contacts.map((contact) => contact.id) } },
          data: { selectedForSend: true, status: "AUDIO_PENDING" },
        });
      }
      for (const contact of [...unfinished, ...contacts])
        await enqueueGenerateAudio(campaign.id, contact.id, false);
      if (unfinished.length + contacts.length === 0)
        await maybeCompleteCampaign(campaign.id);
    }
    await recordJobFinish(job);
  } catch (error) {
    await recordJobFinish(job, error);
    throw error;
  }
}

function templateContext(cc: {
  contact: {
    firstName: string | null;
    lastName: string | null;
    ownerName: string | null;
  };
  property: {
    propertyAddress: string | null;
    streetName: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    county: string | null;
    acreage: Prisma.Decimal | null;
    propertyType: string | null;
  } | null;
}) {
  return {
    first_name: cc.contact.firstName ?? "",
    last_name: cc.contact.lastName ?? "",
    owner_name: cc.contact.ownerName ?? "",
    property_address: cc.property?.propertyAddress ?? "",
    street_name: cc.property?.streetName ?? "",
    city: cc.property?.city ?? "",
    state: cc.property?.state ?? "",
    postal_code: cc.property?.postalCode ?? "",
    county: cc.property?.county ?? "",
    acreage: cc.property?.acreage?.toString() ?? "",
    property_type: cc.property?.propertyType ?? "",
  };
}

export async function handleGenerateAudio(job: Job<unknown>) {
  const data = audioSchema.parse(job.data);
  await recordJobStart(job, data.campaignId, data.campaignContactId);
  try {
    const cc = await db.campaignContact.findUniqueOrThrow({
      where: { id: data.campaignContactId },
      include: {
        contact: true,
        property: true,
        campaign: {
          include: { scriptTemplateVersion: true, voiceConfiguration: true },
        },
      },
    });
    if (cc.campaign.status === "PAUSED" || cc.campaign.status === "FAILED") {
      await recordJobFinish(job);
      return;
    }
    const script = cc.campaign.scriptTemplateVersion;
    const voice = cc.campaign.voiceConfiguration;
    if (!script || !voice)
      throw new Error("Campaign script and voice must be configured");
    const renderedText = renderVoicemailTemplate(
      script.body,
      templateContext(cc),
    );
    const textHash = sha256(
      `${renderedText}\0${voice.voiceId}\0${voice.modelId}`,
    );
    const existing = await db.audioAsset.findUnique({
      where: {
        campaignContactId_textHash_voiceId_modelId: {
          campaignContactId: cc.id,
          textHash,
          voiceId: voice.voiceId,
          modelId: voice.modelId,
        },
      },
    });
    if (existing?.status === "READY") {
      if (!data.preview)
        await enqueueSendDrop(data.campaignId, cc.id, existing.id);
      await finalizePreview(data.campaignId);
      await recordJobFinish(job);
      return;
    }
    const asset =
      existing ??
      (await db.audioAsset.create({
        data: {
          campaignContactId: cc.id,
          scriptTemplateVersionId: script.id,
          voiceConfigurationId: voice.id,
          renderedText,
          textHash,
          voiceId: voice.voiceId,
          modelId: voice.modelId,
          characterCount: renderedText.length,
        },
      }));
    await db.audioAsset.update({
      where: { id: asset.id },
      data: { status: "GENERATING", errorMessage: null },
    });
    const { tts, storage } = getProviders();
    const generated = await tts.generate({
      text: renderedText,
      voiceId: voice.voiceId,
      modelId: voice.modelId,
      settings:
        voice.settings && typeof voice.settings === "object"
          ? (voice.settings as Record<string, unknown>)
          : undefined,
    });
    const extension = generated.contentType.includes("wav") ? "wav" : "mp3";
    const objectKey = `campaigns/${cc.campaignId}/contacts/${cc.id}/${textHash}.${extension}`;
    await storage.put({
      key: objectKey,
      bytes: generated.bytes,
      contentType: generated.contentType,
    });
    const settings = await getNumericSettings();
    const estimatedCostCents = Math.round(
      (generated.characterCount / 1000) *
        settings.elevenlabs_cost_per_1000_chars_cents,
    );
    const ready = await db.audioAsset.update({
      where: { id: asset.id },
      data: {
        status: "READY",
        objectKey,
        contentType: generated.contentType,
        characterCount: generated.characterCount,
        providerGenerationId: generated.providerGenerationId,
        durationSeconds: generated.durationSeconds,
        estimatedCostCents,
        generatedAt: new Date(),
      },
    });
    await db.campaignContact.update({
      where: { id: cc.id },
      data: { status: "AUDIO_READY", renderedText },
    });
    if (data.preview) await finalizePreview(data.campaignId);
    else await enqueueSendDrop(data.campaignId, cc.id, ready.id);
    await recordJobFinish(job);
  } catch (error) {
    await db.campaignContact.updateMany({
      where: { id: data.campaignContactId },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    await recordJobFinish(job, error);
    throw error;
  }
}

async function finalizePreview(campaignId: string) {
  const [selected, ready] = await Promise.all([
    db.campaignContact.count({ where: { campaignId, isPreview: true } }),
    db.campaignContact.count({
      where: {
        campaignId,
        isPreview: true,
        audioAssets: { some: { status: "READY" } },
      },
    }),
  ]);
  if (selected > 0 && selected === ready) {
    await db.campaign.updateMany({
      where: { id: campaignId, status: "PREVIEW_GENERATING" },
      data: { status: "PREVIEW_READY" },
    });
  }
}

export async function handleSendDrop(job: Job<unknown>) {
  const data = sendSchema.parse(job.data);
  await recordJobStart(job, data.campaignId, data.campaignContactId);
  try {
    const cc = await db.campaignContact.findUniqueOrThrow({
      where: { id: data.campaignContactId },
      include: { campaign: true, contact: true, property: true },
    });
    if (cc.campaign.status === "PAUSED") {
      await db.campaignContact.update({
        where: { id: cc.id },
        data: { status: "AUDIO_READY" },
      });
      await recordJobFinish(job);
      return;
    }
    if (cc.campaign.status !== "SENDING")
      throw new Error(`Campaign is not sendable (${cc.campaign.status})`);
    const suppression = await db.suppressionEntry.findUnique({
      where: { normalizedPhone: cc.contact.normalizedPhone },
    });
    if (suppression) {
      await db.campaignContact.update({
        where: { id: cc.id },
        data: {
          status: "SKIPPED",
          errorCode: "SUPPRESSED",
          errorMessage: "Suppressed before send",
        },
      });
      await maybeCompleteCampaign(data.campaignId);
      await recordJobFinish(job);
      return;
    }
    const audio = await db.audioAsset.findUniqueOrThrow({
      where: { id: data.audioAssetId },
    });
    if (audio.status !== "READY" || !audio.objectKey)
      throw new Error("Audio is not ready");
    let drop = await db.drop.findUnique({
      where: {
        campaignContactId_provider: {
          campaignContactId: cc.id,
          provider: "dropcowboy",
        },
      },
    });
    if (
      drop &&
      (drop.queuedAt ||
        ["DRY_RUN", "QUEUED", "SENT", "DELIVERED", "OPTED_OUT"].includes(
          drop.status,
        ))
    ) {
      await recordJobFinish(job);
      return;
    }
    drop ??= await db.drop.create({
      data: { campaignContactId: cc.id, audioAssetId: audio.id },
    });
    await db.campaignContact.update({
      where: { id: cc.id },
      data: { status: "SENDING" },
    });
    const { storage, rvm } = getProviders();
    const audioUrl = await storage.getReadUrl(audio.objectKey);
    const callbackUrl = new URL(
      "/api/webhooks/dropcowboy",
      getEnv().APP_BASE_URL,
    ).toString();
    await assertLiveSendPreconditions({
      campaign: cc.campaign,
      campaignContact: {
        id: cc.id,
        selectedForSend: cc.selectedForSend,
        normalizedPhone: cc.contact.normalizedPhone,
      },
      audio,
      drop,
      callbackUrl,
      rvm,
    });
    if (rvm.live) {
      await db.drop.update({
        where: { id: drop.id },
        data: { queuedAt: new Date() },
      });
    }
    const result = await rvm.send({
      foreignId: drop.id,
      phoneNumber: cc.contact.normalizedPhone,
      media: {
        strategy: "hosted_url",
        url: audioUrl,
        audioType: audio.contentType.toLowerCase().includes("wav")
          ? "wav"
          : "mp3",
      },
      postalCode: cc.property?.postalCode ?? undefined,
      callbackUrl,
    });
    const estimatedCost = (await getNumericSettings())
      .rvm_cost_per_delivered_drop_cents;
    await db.drop.update({
      where: { id: drop.id },
      data: {
        status:
          result.status === "dry_run"
            ? "DRY_RUN"
            : result.status === "sent"
              ? "SENT"
              : "QUEUED",
        providerMessageId: result.providerMessageId,
        providerResponse: result.rawResponse as Prisma.InputJsonValue,
        estimatedCostCents: result.status === "dry_run" ? 0 : estimatedCost,
        queuedAt: drop.queuedAt ?? new Date(),
        sentAt: result.status === "sent" ? new Date() : undefined,
      },
    });
    await db.campaignContact.update({
      where: { id: cc.id },
      data: { status: result.status === "dry_run" ? "SKIPPED" : "QUEUED" },
    });
    await maybeCompleteCampaign(data.campaignId);
    await recordJobFinish(job);
  } catch (error) {
    await db.campaignContact.updateMany({
      where: { id: data.campaignContactId },
      data: {
        status: "FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    await db.drop.updateMany({
      where: { campaignContactId: data.campaignContactId },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    await recordJobFinish(job, error);
    throw error;
  }
}

export async function maybeCompleteCampaign(campaignId: string) {
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, sendLimit: true },
  });
  if (!campaign || campaign.status !== "SENDING") return;
  const active = await db.campaignContact.count({
    where: {
      campaignId,
      selectedForSend: true,
      status: { in: ["AUDIO_PENDING", "AUDIO_READY", "QUEUED", "SENDING"] },
    },
  });
  if (active === 0)
    await db.campaign.update({
      where: { id: campaignId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
}
