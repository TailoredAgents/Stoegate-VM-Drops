export const MIN_SMS_SEND_INTERVAL_SECONDS = 1;
export const MAX_SMS_SEND_INTERVAL_SECONDS = 3_600;

export function requireSmsSendIntervalSeconds(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_SMS_SEND_INTERVAL_SECONDS ||
    value > MAX_SMS_SEND_INTERVAL_SECONDS
  ) {
    throw new Error(
      `SMS send interval must be between ${MIN_SMS_SEND_INTERVAL_SECONDS} and ${MAX_SMS_SEND_INTERVAL_SECONDS} seconds`,
    );
  }
  return value;
}

export function scheduledSmsTime(
  campaignStart: Date,
  zeroBasedPosition: number,
  intervalSeconds: number,
): Date {
  requireSmsSendIntervalSeconds(intervalSeconds);
  if (!Number.isSafeInteger(zeroBasedPosition) || zeroBasedPosition < 0) {
    throw new Error("SMS schedule position must be a non-negative integer");
  }
  return new Date(
    campaignStart.getTime() + zeroBasedPosition * intervalSeconds * 1_000,
  );
}
