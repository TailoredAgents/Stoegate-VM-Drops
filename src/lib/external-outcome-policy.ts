import type {
  ExternalOutcomeChannel,
  OutreachSequenceState,
} from "@prisma/client";
import {
  externalOutcomeTransition,
  type ExternalOutcomeTransition,
} from "@/lib/outreach-state";

export interface ExternalOutcomeSequenceSnapshot {
  currentState: OutreachSequenceState;
  rvmSuccessfulAt: Date | null;
  smsEligibleAt: Date | null;
  smsExportedAt: Date | null;
  smsSentAt: Date | null;
  coldCallExportedAt: Date | null;
}

function before(value: Date, anchor: Date | null) {
  return anchor !== null && value.getTime() < anchor.getTime();
}

/**
 * Validate that an imported provider result could have occurred in the
 * sequence being credited. Suppression results remain stage-independent so a
 * DNC is never ignored, but identity matching still happens before this rule.
 */
export function assertExternalOutcomeAllowed(
  sequence: ExternalOutcomeSequenceSnapshot,
  channel: ExternalOutcomeChannel,
  result: string,
  occurredAt: Date,
): ExternalOutcomeTransition {
  const transition = externalOutcomeTransition(channel, result);

  if (transition.suppress) return transition;
  if (
    sequence.currentState === "OPT_OUT" ||
    sequence.currentState === "WRONG_NUMBER"
  )
    throw new Error(`Sequence is suppressed at ${sequence.currentState}`);
  if (!sequence.rvmSuccessfulAt)
    throw new Error("The contact has no successful RVM delivery");

  if (channel === "SMS") {
    if (!sequence.smsExportedAt)
      throw new Error("The contact was not exported for external SMS");
    if (before(occurredAt, sequence.smsExportedAt))
      throw new Error("SMS outcome occurred before the SMS export");

    if (transition.state === "SMS_SENT_EXTERNAL") {
      if (sequence.smsSentAt)
        throw new Error("SMS sent was already recorded for this sequence");
      if (!["SMS_EXPORTED", "SMS_FAILED"].includes(sequence.currentState))
        throw new Error(`SMS sent is not valid from ${sequence.currentState}`);
      return transition;
    }

    if (transition.state === "SMS_FAILED") {
      if (
        !["SMS_EXPORTED", "SMS_SENT_EXTERNAL", "SMS_FAILED"].includes(
          sequence.currentState,
        )
      )
        throw new Error(
          `SMS failure is not valid from ${sequence.currentState}`,
        );
      return transition;
    }

    if (!sequence.smsSentAt)
      throw new Error("An SMS response requires a recorded external send");
    if (before(occurredAt, sequence.smsSentAt))
      throw new Error("SMS response occurred before the recorded SMS send");
    return transition;
  }

  if (!sequence.coldCallExportedAt)
    throw new Error("The contact was not exported for cold calling");
  if (before(occurredAt, sequence.coldCallExportedAt))
    throw new Error("Cold-call outcome occurred before the BatchDialer export");
  return transition;
}
