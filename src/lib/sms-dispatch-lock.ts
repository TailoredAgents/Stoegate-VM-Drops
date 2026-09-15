import { Client } from "pg";
import type { Prisma } from "@prisma/client";

import { getEnv } from "@/lib/env";

export function smsCampaignDispatchLockKey(campaignId: string) {
  return `sms-campaign-dispatch:${campaignId}`;
}

export function smsCampaignPacingLockKey(campaignId: string) {
  return `sms-campaign-pacing:${campaignId}`;
}

export function smsProviderReadinessLockKey(providerKey: string) {
  return `sms-provider-readiness:${providerKey.trim().toLowerCase()}`;
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

export async function lockSmsCampaignPacingTx(
  tx: Prisma.TransactionClient,
  campaignId: string,
) {
  const key = smsCampaignPacingLockKey(campaignId);
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked
  `;
}

export async function lockSmsProviderReadinessSharedTx(
  tx: Prisma.TransactionClient,
  providerKey: string,
) {
  const key = smsProviderReadinessLockKey(providerKey);
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock_shared(hashtext(${key}))::text AS locked
  `;
}

export async function lockSmsProviderReadinessTx(
  tx: Prisma.TransactionClient,
  providerKey: string,
) {
  const key = smsProviderReadinessLockKey(providerKey);
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
    providerKey: string;
    campaignId: string;
    normalizedPhone: string;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: getEnv().DATABASE_URL });
  const readinessKey = smsProviderReadinessLockKey(input.providerKey);
  const pacingKey = smsCampaignPacingLockKey(input.campaignId);
  const campaignKey = smsCampaignDispatchLockKey(input.campaignId);
  const phoneKey = smsPhoneDispatchLockKey(input.normalizedPhone);
  let readinessLocked = false;
  let pacingLocked = false;
  let campaignLocked = false;
  let phoneLocked = false;

  await client.connect();
  try {
    // Provider readiness writers take the exclusive form of this lock. Keep a
    // shared lock through reservation, provider submission, and persistence so
    // approval revocation has a strict before/after ordering with a send.
    await client.query(
      "SELECT pg_advisory_lock_shared(hashtext($1))::text AS locked",
      [readinessKey],
    );
    readinessLocked = true;
    // One campaign submission owns this lock through provider persistence.
    // Reservation then checks the previous attempt timestamp, preventing a
    // delayed queue from collapsing its originally staggered jobs into a burst.
    await client.query(
      "SELECT pg_advisory_lock(hashtext($1))::text AS locked",
      [pacingKey],
    );
    pacingLocked = true;
    // Shared campaign locks permit parallel contacts while an exclusive pause
    // lock waits for the current in-flight dispatch to finish.
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
      if (pacingLocked)
        await client.query(
          "SELECT pg_advisory_unlock(hashtext($1))::text AS unlocked",
          [pacingKey],
        );
      if (readinessLocked)
        await client.query(
          "SELECT pg_advisory_unlock_shared(hashtext($1))::text AS unlocked",
          [readinessKey],
        );
    } finally {
      await client.end();
    }
  }
}

/**
 * Serialize callback-side state changes with the provider submission window
 * for one recipient. This is intentionally a session lock because the status
 * persistence and suppression writes use separate Prisma transactions.
 */
export async function withSmsPhoneDispatchLock<T>(
  normalizedPhone: string,
  operation: () => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: getEnv().DATABASE_URL });
  const phoneKey = smsPhoneDispatchLockKey(normalizedPhone);
  let phoneLocked = false;

  await client.connect();
  try {
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
    } finally {
      await client.end();
    }
  }
}
