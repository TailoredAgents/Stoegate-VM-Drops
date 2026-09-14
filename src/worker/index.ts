import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  handlePrepareCampaign,
  handleReconcileOutreach,
  handleSendSms,
} from "@/jobs/handlers";
import { getBoss, QUEUES, startBoss } from "@/jobs/queues";

async function main() {
  const env = getEnv();
  const boss = await startBoss();
  const workerOptions = { localConcurrency: env.WORKER_CONCURRENCY };
  await boss.work(QUEUES.prepareCampaign, workerOptions, async (jobs) =>
    Promise.all(jobs.map(handlePrepareCampaign)),
  );
  await boss.work(QUEUES.sendSms, workerOptions, async (jobs) =>
    Promise.all(jobs.map(handleSendSms)),
  );
  await boss.work(
    QUEUES.reconcileOutreach,
    { localConcurrency: 1 },
    async (jobs) => Promise.all(jobs.map(handleReconcileOutreach)),
  );
  logger.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      smsProvider: env.SMS_PROVIDER,
      liveSms: env.SMS_LIVE_SENDS_ENABLED,
    },
    "SMS worker started",
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "SMS worker shutting down");
    await getBoss().stop({ graceful: true, timeout: 25_000 });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  logger.fatal({ error }, "SMS worker failed to start");
  process.exit(1);
});
