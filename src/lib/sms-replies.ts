export const SMS_REPLY_CLASSIFICATIONS = [
  "INTERESTED",
  "MAYBE",
  "FOLLOW_UP",
  "NOT_INTERESTED",
  "WRONG_NUMBER",
  "PROPERTY_SOLD",
  "AGENT",
  "OPT_OUT",
  "HOSTILE",
  "OTHER",
  "QUALIFIED_LEAD",
] as const;

export type SmsReplyClassification = (typeof SMS_REPLY_CLASSIFICATIONS)[number];

const optOutKeywords = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);

const optOutPhrases = new Set([
  "OPT OUT",
  "REMOVE ME",
  "DO NOT TEXT",
  "DONT TEXT",
  "DON'T TEXT",
  "STOP TEXTING",
  "STOP ALL",
  "NO MORE TEXTS",
  "PLEASE STOP",
  "STOP PLEASE",
]);

function normalizedSmsReplyText(body: string): string {
  return body
    .trim()
    .toUpperCase()
    .replace(/[’]/g, "'")
    .replace(/^[^A-Z0-9']+|[^A-Z0-9']+$/g, "")
    .replace(/\s+/g, " ");
}

export function normalizedSmsKeyword(body: string): string {
  return (
    body
      .trim()
      .toUpperCase()
      .match(/^[A-Z]+/)?.[0] ?? ""
  );
}

export function isSmsOptOutText(body: string): boolean {
  const normalized = normalizedSmsReplyText(body);
  return optOutKeywords.has(normalized) || optOutPhrases.has(normalized);
}

export function classificationCreatesSuppression(
  classification: SmsReplyClassification,
): "OPT_OUT" | "WRONG_NUMBER" | null {
  if (classification === "OPT_OUT") return "OPT_OUT";
  if (classification === "WRONG_NUMBER") return "WRONG_NUMBER";
  return null;
}

export function classificationCreatesLead(
  classification: SmsReplyClassification,
): boolean {
  return classification === "QUALIFIED_LEAD";
}

export function classificationIsInterested(
  classification: SmsReplyClassification,
): boolean {
  return ["INTERESTED", "MAYBE", "FOLLOW_UP", "QUALIFIED_LEAD"].includes(
    classification,
  );
}
