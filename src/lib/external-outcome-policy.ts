import type {
  ExternalOutcomeChannel,
  OutreachSequenceState,
} from "@prisma/client";

export const COLD_CALL_OUTCOMES = [
  "CONTACTED",
  "INTERESTED",
  "QUALIFIED_LEAD",
  "NOT_INTERESTED",
  "WRONG_NUMBER",
  "DNC",
  "NO_ANSWER",
  "CONTRACT",
  "CLOSED",
] as const;

export type ColdCallOutcome = (typeof COLD_CALL_OUTCOMES)[number];

export interface ColdCallOutcomeTransition {
  state: OutreachSequenceState;
  terminal: true;
  lead: boolean;
  suppress: "OPT_OUT" | "WRONG_NUMBER" | null;
}

export interface ExternalOutcomeSequenceSnapshot {
  currentState: OutreachSequenceState;
  coldCallExportedAt: Date | null;
}

const outcomeAliases: Readonly<Record<string, ColdCallOutcome>> = {
  contacted: "CONTACTED",
  contact: "CONTACTED",
  answered: "CONTACTED",
  interested: "INTERESTED",
  qualified: "QUALIFIED_LEAD",
  qualified_lead: "QUALIFIED_LEAD",
  not_interested: "NOT_INTERESTED",
  uninterested: "NOT_INTERESTED",
  wrong_number: "WRONG_NUMBER",
  bad_number: "WRONG_NUMBER",
  dnc: "DNC",
  do_not_call: "DNC",
  opt_out: "DNC",
  no_answer: "NO_ANSWER",
  no_response: "NO_ANSWER",
  unanswered: "NO_ANSWER",
  contract: "CONTRACT",
  closed: "CLOSED",
};

const outcomeTransitions: Readonly<
  Record<ColdCallOutcome, ColdCallOutcomeTransition>
> = {
  CONTACTED: {
    state: "COLD_CALL_CONTACTED",
    terminal: true,
    lead: false,
    suppress: null,
  },
  INTERESTED: {
    state: "INTERESTED",
    terminal: true,
    lead: true,
    suppress: null,
  },
  QUALIFIED_LEAD: {
    state: "QUALIFIED_LEAD",
    terminal: true,
    lead: true,
    suppress: null,
  },
  NOT_INTERESTED: {
    state: "NOT_INTERESTED",
    terminal: true,
    lead: false,
    suppress: null,
  },
  WRONG_NUMBER: {
    state: "WRONG_NUMBER",
    terminal: true,
    lead: false,
    suppress: "WRONG_NUMBER",
  },
  DNC: {
    state: "OPT_OUT",
    terminal: true,
    lead: false,
    suppress: "OPT_OUT",
  },
  NO_ANSWER: {
    state: "COLD_CALL_NO_ANSWER",
    terminal: true,
    lead: false,
    suppress: null,
  },
  CONTRACT: {
    state: "CONTRACT",
    terminal: true,
    lead: true,
    suppress: null,
  },
  CLOSED: {
    state: "CLOSED",
    terminal: true,
    lead: true,
    suppress: null,
  },
};

function normalizedLabel(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeColdCallOutcome(result: string): ColdCallOutcome {
  const outcome = outcomeAliases[normalizedLabel(result)];
  if (!outcome)
    throw new Error(`Unsupported cold-call outcome: ${result || "(blank)"}`);
  return outcome;
}

/**
 * A cold-call outcome may only be credited after Stonegate exported the
 * sequence to BatchDialer. This applies to suppressions too: the importer must
 * establish the exact exported identity before changing global suppression.
 */
export function assertColdCallOutcomeAllowed(
  sequence: ExternalOutcomeSequenceSnapshot,
  result: string,
  occurredAt: Date,
): ColdCallOutcomeTransition {
  const outcome = normalizeColdCallOutcome(result);
  if (!Number.isFinite(occurredAt.getTime()))
    throw new Error("Cold-call outcome timestamp is invalid");
  if (!sequence.coldCallExportedAt)
    throw new Error("The contact was not exported to BatchDialer");
  if (occurredAt.getTime() < sequence.coldCallExportedAt.getTime())
    throw new Error("Cold-call outcome occurred before the BatchDialer export");

  const isSuppression = outcome === "DNC" || outcome === "WRONG_NUMBER";
  if (
    !isSuppression &&
    (sequence.currentState === "OPT_OUT" ||
      sequence.currentState === "WRONG_NUMBER")
  )
    throw new Error(`Sequence is suppressed at ${sequence.currentState}`);

  return outcomeTransitions[outcome];
}

/**
 * Compatibility boundary used by the shared outreach event writer. External
 * SMS imports are deliberately unavailable in this phase.
 */
export function assertExternalOutcomeAllowed(
  sequence: ExternalOutcomeSequenceSnapshot,
  channel: ExternalOutcomeChannel,
  result: string,
  occurredAt: Date,
): ColdCallOutcomeTransition {
  if (channel !== "COLD_CALL")
    throw new Error("Only COLD_CALL outcomes can be imported");
  return assertColdCallOutcomeAllowed(sequence, result, occurredAt);
}
