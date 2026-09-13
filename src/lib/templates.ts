import Handlebars from "handlebars";
import { z } from "zod";

export const templateContextSchema = z.object({
  first_name: z.string().optional().default(""),
  last_name: z.string().optional().default(""),
  owner_name: z.string().optional().default(""),
  property_address: z.string().optional().default(""),
  street_name: z.string().optional().default(""),
  city: z.string().optional().default(""),
  state: z.string().optional().default(""),
  county: z.string().optional().default(""),
  postal_code: z.string().optional().default(""),
  acreage: z.string().optional().default(""),
  property_type: z.string().optional().default(""),
});

export type TemplateContext = z.input<typeof templateContextSchema>;

export function renderVoicemailTemplate(
  template: string,
  input: TemplateContext,
): string {
  const context = templateContextSchema.parse(input);
  const compiled = Handlebars.compile(template, {
    noEscape: true,
    strict: false,
    preventIndent: true,
  });
  return compiled(context, {
    allowProtoMethodsByDefault: false,
    allowProtoPropertiesByDefault: false,
  })
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

export function validateTemplate(
  template: string,
): { valid: true } | { valid: false; error: string } {
  try {
    Handlebars.precompile(template);
    renderVoicemailTemplate(template, {});
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid template",
    };
  }
}
