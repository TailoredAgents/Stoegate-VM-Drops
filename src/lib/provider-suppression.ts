/**
 * Small, explicit allowlist of provider errors that are authoritative
 * recipient-level suppression signals. All other provider errors remain
 * diagnostics only because their meanings and retry semantics can change.
 */
export function isProviderOptOutSignal(
  providerKey: string,
  errorCode: string | null | undefined,
) {
  return (
    providerKey.trim().toLowerCase() === "twilio" &&
    errorCode?.trim() === "21610"
  );
}
