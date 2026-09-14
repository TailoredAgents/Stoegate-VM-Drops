import { createHmac, timingSafeEqual } from "node:crypto";

export function smsWebhookSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifySmsWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = Buffer.from(smsWebhookSignature(rawBody, secret));
  const received = Buffer.from(signature.trim().toLowerCase());
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
}
