import { parsePhoneNumberFromString } from "libphonenumber-js";

export function normalizeUSPhone(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, "US");
  if (!parsed?.isValid() || parsed.country !== "US") return null;
  return parsed.number;
}

export function providerPhone(e164: string): string {
  return e164;
}
