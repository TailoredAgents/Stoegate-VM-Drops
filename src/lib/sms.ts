import Handlebars from "handlebars";
import { z } from "zod";

const smsHandlebars = Handlebars.create();

const nullableTemplateValueSchema = z.union([z.string(), z.number()]).nullish();

export const smsTemplateContextSchema = z.object({
  first_name: nullableTemplateValueSchema,
  owner_name: nullableTemplateValueSchema,
  property_address: nullableTemplateValueSchema,
  street_name: nullableTemplateValueSchema,
  city: nullableTemplateValueSchema,
  state: nullableTemplateValueSchema,
  county: nullableTemplateValueSchema,
  acreage: nullableTemplateValueSchema,
  property_type: nullableTemplateValueSchema,
});

export type SMSTemplateContext = z.input<typeof smsTemplateContextSchema>;

export interface ResolvedSMSTemplateContext {
  first_name: string;
  owner_name: string;
  property_address: string;
  street_name: string;
  city: string;
  state: string;
  county: string;
  acreage: string;
  property_type: string;
}

/**
 * Human-readable fallback policy exposed for template editors and UI help.
 * Optional location/acreage fields become blank so they can be guarded with
 * Handlebars `#if`; identity and property nouns always get safe copy.
 */
export const SMS_TEMPLATE_FALLBACK_POLICY = Object.freeze({
  first_name: "first word of owner_name, otherwise 'there'",
  owner_name: "first_name, otherwise 'there'",
  property_address: "street_name, otherwise 'your property'",
  street_name: "property_address, otherwise 'your property'",
  city: "blank",
  state: "blank",
  county: "blank",
  acreage: "blank",
  property_type: "'property'",
} as const);

function asCleanString(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function resolveSmsTemplateContext(
  input: SMSTemplateContext,
): ResolvedSMSTemplateContext {
  const parsed = smsTemplateContextSchema.parse(input);
  const firstName = asCleanString(parsed.first_name);
  const ownerName = asCleanString(parsed.owner_name);
  const propertyAddress = asCleanString(parsed.property_address);
  const streetName = asCleanString(parsed.street_name);

  return {
    first_name: firstName || ownerName.split(/\s+/u)[0] || "there",
    owner_name: ownerName || firstName || "there",
    property_address: propertyAddress || streetName || "your property",
    street_name: streetName || propertyAddress || "your property",
    city: asCleanString(parsed.city),
    state: asCleanString(parsed.state),
    county: asCleanString(parsed.county),
    acreage: asCleanString(parsed.acreage),
    property_type: asCleanString(parsed.property_type) || "property",
  };
}

function normalizeRenderedSms(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\t ]+([,.!?])/g, "$1")
    .trim();
}

export function renderSmsTemplate(
  template: string,
  input: SMSTemplateContext,
): string {
  const compiled = smsHandlebars.compile(template, {
    noEscape: true,
    strict: true,
    preventIndent: true,
  });
  const rendered = normalizeRenderedSms(
    compiled(resolveSmsTemplateContext(input), {
      allowProtoMethodsByDefault: false,
      allowProtoPropertiesByDefault: false,
    }),
  );

  if (!rendered) {
    throw new Error("SMS template rendered an empty message");
  }

  return rendered;
}

export function validateSmsTemplate(
  template: string,
): { valid: true } | { valid: false; error: string } {
  try {
    smsHandlebars.precompile(template, {
      noEscape: true,
      strict: true,
      preventIndent: true,
    });
    renderSmsTemplate(template, {
      first_name: "Sam",
      owner_name: "Sam Owner",
      property_address: "1 Main St",
      street_name: "Main St",
      city: "Austin",
      state: "TX",
      county: "Travis",
      acreage: "2.5",
      property_type: "house",
    });
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid SMS template",
    };
  }
}

export type SMSEncoding = "GSM_7" | "UCS_2";

const GSM_7_BASIC_CHARACTERS = new Set(
  [
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ",
    " !\"#¤%&'()*+,-./0123456789:;<=>?¡",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿",
    "abcdefghijklmnopqrstuvwxyzäöñüà",
  ]
    .join("")
    .split(""),
);
const GSM_7_EXTENSION_CHARACTERS = new Set("\f^{}\\[~]|€".split(""));

export const SMS_SEGMENT_LIMITS = Object.freeze({
  GSM_7: Object.freeze({ single: 160, concatenated: 153 }),
  UCS_2: Object.freeze({ single: 70, concatenated: 67 }),
} as const);

export type SMSAnalysisWarningCode = "MULTI_SEGMENT" | "UNICODE_ENCODING";

export interface SMSAnalysisWarning {
  code: SMSAnalysisWarningCode;
  message: string;
}

export interface SMSSegmentEstimate {
  encoding: SMSEncoding;
  /** Unicode code points, for human-facing character counts. */
  characterCount: number;
  /** GSM septets or UTF-16 code units, depending on encoding. */
  encodingUnitCount: number;
  segmentCount: number;
  unitsPerSegment: number;
  isMultipart: boolean;
  /** Explicit contract: this analyzer never modifies or truncates the body. */
  wasTruncated: false;
  warnings: readonly SMSAnalysisWarning[];
}

export function estimateSmsSegments(body: string): SMSSegmentEstimate {
  const characters = Array.from(body);
  const isGsm7 = characters.every(
    (character) =>
      GSM_7_BASIC_CHARACTERS.has(character) ||
      GSM_7_EXTENSION_CHARACTERS.has(character),
  );
  const encoding: SMSEncoding = isGsm7 ? "GSM_7" : "UCS_2";
  const encodingUnitCount = isGsm7
    ? characters.reduce(
        (total, character) =>
          total + (GSM_7_EXTENSION_CHARACTERS.has(character) ? 2 : 1),
        0,
      )
    : body.length;
  const limits = SMS_SEGMENT_LIMITS[encoding];
  const segmentCount =
    encodingUnitCount === 0
      ? 0
      : encodingUnitCount <= limits.single
        ? 1
        : Math.ceil(encodingUnitCount / limits.concatenated);
  const isMultipart = segmentCount > 1;
  const warnings: SMSAnalysisWarning[] = [];

  if (!isGsm7) {
    warnings.push({
      code: "UNICODE_ENCODING",
      message:
        "Unicode characters reduce SMS capacity to 70 units, or 67 per concatenated segment.",
    });
  }
  if (isMultipart) {
    warnings.push({
      code: "MULTI_SEGMENT",
      message: `This message will use an estimated ${segmentCount} SMS segments.`,
    });
  }

  return {
    encoding,
    characterCount: characters.length,
    encodingUnitCount,
    segmentCount,
    unitsPerSegment: isMultipart ? limits.concatenated : limits.single,
    isMultipart,
    wasTruncated: false,
    warnings,
  };
}

export interface SMSCostConfiguration {
  /** Supports fractional cents because carrier/provider rates are often sub-cent. */
  costPerSegmentCents: number;
  fixedCostPerMessageCents?: number;
}

export interface SMSProviderCostEstimate {
  segmentCount: number;
  segmentCostCents: number;
  fixedCostCents: number;
  estimatedProviderCostCents: number;
}

function requireNonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return value;
}

export function estimateSmsProviderCost(
  segmentCount: number,
  configuration: SMSCostConfiguration,
): SMSProviderCostEstimate {
  if (!Number.isInteger(segmentCount) || segmentCount < 0) {
    throw new Error("segmentCount must be a non-negative integer");
  }
  const costPerSegmentCents = requireNonNegativeFinite(
    configuration.costPerSegmentCents,
    "costPerSegmentCents",
  );
  const configuredFixedCost = requireNonNegativeFinite(
    configuration.fixedCostPerMessageCents ?? 0,
    "fixedCostPerMessageCents",
  );
  const segmentCostCents = segmentCount * costPerSegmentCents;
  const fixedCostCents = segmentCount === 0 ? 0 : configuredFixedCost;

  return {
    segmentCount,
    segmentCostCents,
    fixedCostCents,
    estimatedProviderCostCents: segmentCostCents + fixedCostCents,
  };
}

export interface PreparedSMSMessage {
  body: string;
  segments: SMSSegmentEstimate;
  estimatedProviderCost?: SMSProviderCostEstimate;
}

export function prepareSmsMessage(
  template: string,
  context: SMSTemplateContext,
  costConfiguration?: SMSCostConfiguration,
): PreparedSMSMessage {
  const body = renderSmsTemplate(template, context);
  const segments = estimateSmsSegments(body);

  return {
    body,
    segments,
    ...(costConfiguration
      ? {
          estimatedProviderCost: estimateSmsProviderCost(
            segments.segmentCount,
            costConfiguration,
          ),
        }
      : {}),
  };
}
