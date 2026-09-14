import type {
  AttributionChannel,
  CallbackOutcomeType,
  ExternalOutcomeChannel,
  OutreachSequenceState,
} from "@prisma/client";

const terminalStates = new Set<OutreachSequenceState>([
  "RVM_FAILED",
  "RVM_CALLBACK",
  "SMS_REPLIED",
  "COLD_CALL_CONTACTED",
  "COLD_CALL_NO_ANSWER",
  "INTERESTED",
  "QUALIFIED_LEAD",
  "FOLLOW_UP",
  "NOT_INTERESTED",
  "WRONG_NUMBER",
  "OPT_OUT",
  "CONTRACT",
  "CLOSED",
]);

export const callbackStopOutcomes = new Set<CallbackOutcomeType>([
  "CALLBACK",
  "INTERESTED",
  "QUALIFIED_LEAD",
  "FOLLOW_UP",
  "NOT_INTERESTED",
  "WRONG_NUMBER",
  "OPT_OUT",
  "CONTRACT",
  "CLOSED",
]);

export const leadOutcomes = new Set<CallbackOutcomeType>([
  "INTERESTED",
  "QUALIFIED_LEAD",
  "CONTRACT",
  "CLOSED",
]);

export function isTerminalOutreachState(state: OutreachSequenceState): boolean {
  return terminalStates.has(state);
}

export function shouldStopForCallbackOutcome(
  outcome: CallbackOutcomeType,
): boolean {
  return callbackStopOutcomes.has(outcome);
}

export function isLeadOutcome(outcome: CallbackOutcomeType): boolean {
  return leadOutcomes.has(outcome);
}

export function stateForCallbackOutcome(
  outcome: CallbackOutcomeType,
): OutreachSequenceState {
  return outcome === "CALLBACK" ? "RVM_CALLBACK" : outcome;
}

const leadProgression: Partial<Record<OutreachSequenceState, number>> = {
  INTERESTED: 1,
  QUALIFIED_LEAD: 2,
  CONTRACT: 3,
  CLOSED: 4,
};

export function resolveOutcomeState(
  current: OutreachSequenceState,
  proposed: OutreachSequenceState,
): OutreachSequenceState {
  if (current === "OPT_OUT" || current === "WRONG_NUMBER") return current;
  if (proposed === "OPT_OUT" || proposed === "WRONG_NUMBER") return proposed;
  const currentRank = leadProgression[current] ?? 0;
  const proposedRank = leadProgression[proposed] ?? 0;
  if (currentRank > proposedRank) return current;
  return proposed;
}

export function eligibilityAt(anchor: Date, delayHours: number): Date {
  return new Date(anchor.getTime() + delayHours * 60 * 60 * 1000);
}

export function isRvmToSmsDue(
  state: OutreachSequenceState,
  dueAt: Date | null,
  now: Date,
): boolean {
  return (
    state === "SMS_NOT_YET_ELIGIBLE" &&
    dueAt !== null &&
    dueAt.getTime() <= now.getTime()
  );
}

export function isSmsToColdCallDue(
  state: OutreachSequenceState,
  dueAt: Date | null,
  now: Date,
): boolean {
  return (
    state === "SMS_SENT_EXTERNAL" &&
    dueAt !== null &&
    dueAt.getTime() <= now.getTime()
  );
}

export type ExternalOutcomeTransition = {
  state: OutreachSequenceState;
  terminal: boolean;
  lead: boolean;
  suppress: "OPT_OUT" | "WRONG_NUMBER" | null;
};

export function externalOutcomeTransition(
  channel: ExternalOutcomeChannel,
  rawResult: string,
): ExternalOutcomeTransition {
  const result = rawResult
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const shared: Record<string, ExternalOutcomeTransition> = {
    interested: {
      state: "INTERESTED",
      terminal: true,
      lead: true,
      suppress: null,
    },
    qualified: {
      state: "QUALIFIED_LEAD",
      terminal: true,
      lead: true,
      suppress: null,
    },
    qualified_lead: {
      state: "QUALIFIED_LEAD",
      terminal: true,
      lead: true,
      suppress: null,
    },
    not_interested: {
      state: "NOT_INTERESTED",
      terminal: true,
      lead: false,
      suppress: null,
    },
    wrong_number: {
      state: "WRONG_NUMBER",
      terminal: true,
      lead: false,
      suppress: "WRONG_NUMBER",
    },
    opt_out: {
      state: "OPT_OUT",
      terminal: true,
      lead: false,
      suppress: "OPT_OUT",
    },
    dnc: {
      state: "OPT_OUT",
      terminal: true,
      lead: false,
      suppress: "OPT_OUT",
    },
    contract: {
      state: "CONTRACT",
      terminal: true,
      lead: true,
      suppress: null,
    },
    closed: {
      state: "CLOSED",
      terminal: true,
      lead: true,
      suppress: null,
    },
  };
  if (shared[result]) return shared[result];

  if (channel === "SMS") {
    if (result === "sent")
      return {
        state: "SMS_SENT_EXTERNAL",
        terminal: false,
        lead: false,
        suppress: null,
      };
    if (result === "reply" || result === "replied" || result === "response")
      return {
        state: "SMS_REPLIED",
        terminal: true,
        lead: false,
        suppress: null,
      };
    if (result === "failed")
      return {
        state: "SMS_FAILED",
        terminal: false,
        lead: false,
        suppress: null,
      };
  } else {
    if (result === "contacted")
      return {
        state: "COLD_CALL_CONTACTED",
        terminal: true,
        lead: false,
        suppress: null,
      };
    if (result === "no_answer" || result === "no_response")
      return {
        state: "COLD_CALL_NO_ANSWER",
        terminal: true,
        lead: false,
        suppress: null,
      };
  }
  throw new Error(`Unsupported ${channel.toLowerCase()} result: ${rawResult}`);
}

export function attributionForExternalChannel(
  channel: ExternalOutcomeChannel,
): AttributionChannel {
  return channel === "SMS" ? "SMS" : "COLD_CALL";
}
