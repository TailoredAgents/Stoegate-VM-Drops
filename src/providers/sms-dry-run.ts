import { createHash } from "node:crypto";

import type { SMSOutboundMessage, SMSProvider, SMSSendResult } from "./types";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requiredTrimmed(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

/**
 * A network-free SMS adapter for orchestration tests and previews.
 *
 * The provider message ID depends only on the idempotency key, so a retry gets
 * the same ID even after a process restart. The separate request fingerprint
 * lets callers detect accidental reuse of that key with different content.
 */
export class DryRunSMSProvider implements SMSProvider {
  readonly name = "dry-run-sms";
  readonly live = false;

  async assertReadyForLiveSend(): Promise<void> {}

  async send(input: SMSOutboundMessage): Promise<SMSSendResult> {
    const idempotencyKey = requiredTrimmed(
      input.idempotencyKey,
      "idempotencyKey",
    );
    const to = requiredTrimmed(input.to, "to");
    const from = input.from?.trim() ?? "";
    const clientReference = input.clientReference?.trim() ?? "";
    const callbackUrl = input.callbackUrl?.trim() ?? "";
    const metadata = Object.fromEntries(
      Object.entries(input.metadata ?? {}).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );

    if (!input.body.trim()) {
      throw new Error("body is required");
    }

    const idempotencyKeyHash = sha256(idempotencyKey);
    const requestFingerprint = sha256(
      JSON.stringify([
        to,
        from,
        input.body,
        clientReference,
        callbackUrl,
        metadata,
      ]),
    );

    return {
      status: "dry_run",
      providerMessageId: `dry-sms-${idempotencyKeyHash.slice(0, 24)}`,
      requestFingerprint,
      rawResponse: {
        dryRun: true,
        idempotencyKeyHash,
        requestFingerprint,
      },
    };
  }
}
