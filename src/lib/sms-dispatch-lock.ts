import { Client } from "pg";
import type { Prisma } from "@prisma/client";

import { getEnv } from "@/lib/env";

export function smsCampaignDispatchLockKey(campaignId: string) {
  return `sms-campaign-dispatch:${campaignId}`;
}

export function smsPhoneDispatchLockKey(normalizedPhone: string) {
  return `sms-suppression:${normalizedPhone}`;
}

export async function lockSmsCampaignDispatchTx(
  tx: Prisma.TransactionClient,
  campaignId: string,
) {
  const key = smsCampaignDispatchLockKey(campaignId);
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked
  `;
}

export async function lockSmsPhoneDispatchTx(
  tx: Prisma.TransactionClient,
  normalizedPhone: string,
) {
  const key = smsPhoneDispatchLockKey(normalizedPhone);
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked
  `;
}

/**
 * Keep pause/suppression changes ordered with the complete provider submission
 * window. The dedicated connection is required because session advisory locks
 * must be acquired and released by the same PostgreSQL session.
 */
export async function withSmsDispatchLock<T>(
  input: {
    campaignId: string;
    normalizedPhone: string;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: getEnv().DATABASE_URL });
  const campaignKey = smsCampaignDispatchLockKey(input.campaignId);
  const phoneKey = smsPhoneDispatchLockKey(input.normalizedPhone);
  let campaignLocked = false;
  let phoneLocked = false;

  await client.connect();
  try {
    // Shared campaign locks permit parallel contacts while an exclusive pause
    // lock waits for every in-flight dispatch to finish.
    await client.query(
      "SELECT pg_advisory_lock_shared(hashtext($1))::text AS locked",
      [campaignKey],
    );
    campaignLocked = true;
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1))::text AS locked",
      [phoneKey],
    );
    phoneLocked = true;
    return await operation();
  } finally {
    try {
      if (phoneLocked)
        await client.query(
          "SELECT pg_advisory_unlock(hashtext($1))::text AS unlocked",
          [phoneKey],
        );
      if (campaignLocked)
        await client.query(
          "SELECT pg_advisory_unlock_shared(hashtext($1))::text AS unlocked",
          [campaignKey],
        );
    } finally {
      await client.end();
    }
  }
}
