/**
 * Messaging Services choose the concrete sender at submission time. Persisting
 * an MG... SID as though it were an E.164 sender would make live reservation
 * reject an otherwise valid Twilio message.
 */
export function initialOutboundFromPhone(
  providerKey: string,
  senderReference: string | null,
) {
  return providerKey.trim().toLowerCase() === "twilio" ? null : senderReference;
}
