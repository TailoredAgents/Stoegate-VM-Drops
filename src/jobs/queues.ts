import { PgBoss } from "pg-boss";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export const QUEUES = {
  prepareCampaign: "campaign-prepare",
  generateAudio: "audio-generate",
  sendDrop: "rvm-send",
} as const;

let boss: PgBoss | undefined;
let started: Promise<PgBoss> | undefined;

export function getBoss(): PgBoss {
  boss ??= new PgBoss({
    connectionString: getEnv().DATABASE_URL,
    application_name: "stonegate-vm-drops",
  });
  return boss;
}

export function startBoss(): Promise<PgBoss> {
  if (started) return started;
  const instance = getBoss();
  instance.on("error", (error) => logger.error({ error }, "pg-boss error"));
  started = (async () => {
    await instance.start();
    for (const name of Object.values(QUEUES)) {
      await instance.createQueue(name, {
        retryLimit: 5,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 1800,
      });
    }
    return instance;
  })();
  return started;
}

export async function enqueuePrepareCampaign(
  campaignId: string,
  mode: "preview" | "bulk",
) {
  const instance = await startBoss();
  return instance.send(
    QUEUES.prepareCampaign,
    { campaignId, mode },
    { singletonKey: `${campaignId}:${mode}` },
  );
}

export async function enqueueGenerateAudio(
  campaignId: string,
  campaignContactId: string,
  preview: boolean,
) {
  const instance = await startBoss();
  return instance.send(
    QUEUES.generateAudio,
    { campaignId, campaignContactId, preview },
    { singletonKey: campaignContactId },
  );
}

export async function enqueueSendDrop(
  campaignId: string,
  campaignContactId: string,
  audioAssetId: string,
) {
  const instance = await startBoss();
  return instance.send(
    QUEUES.sendDrop,
    { campaignId, campaignContactId, audioAssetId },
    { singletonKey: campaignContactId },
  );
}
