import { PgBoss } from "pg-boss";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

export const QUEUES = {
  prepareCampaign: "sms-campaign-prepare",
  sendSms: "sms-send",
  reconcileOutreach: "sms-outreach-reconcile",
} as const;

let boss: PgBoss | undefined;
let started: Promise<PgBoss> | undefined;

export function getBoss(): PgBoss {
  boss ??= new PgBoss({
    connectionString: getEnv().DATABASE_URL,
    application_name: "stonegate-sms-outreach",
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
    await instance.schedule(
      QUEUES.reconcileOutreach,
      "* * * * *",
      {},
      { tz: "UTC", missed: "once" },
    );
    return instance;
  })();
  return started;
}

export async function enqueuePrepareCampaign(
  campaignId: string,
  mode: "preview" | "bulk",
  startAfter?: Date,
) {
  const instance = await startBoss();
  return instance.send(
    QUEUES.prepareCampaign,
    { campaignId, mode },
    {
      singletonKey: `${campaignId}:${mode}`,
      ...(startAfter ? { startAfter } : {}),
    },
  );
}

export async function enqueueSendSms(
  campaignId: string,
  messageId: string,
  startAfter?: Date,
) {
  const instance = await startBoss();
  return instance.send(
    QUEUES.sendSms,
    { campaignId, messageId },
    {
      singletonKey: startAfter
        ? `${messageId}:${startAfter.toISOString()}`
        : messageId,
      ...(startAfter ? { startAfter } : {}),
    },
  );
}
