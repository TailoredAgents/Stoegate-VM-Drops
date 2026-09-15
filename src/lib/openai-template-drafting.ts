import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { getEnv, type AppEnv } from "@/lib/env";
import { validateSmsTemplate } from "@/lib/sms";

const generatedDraftSchema = z.object({
  body: z.string().trim().min(1).max(5_000),
  rationale: z.string().trim().min(1).max(500),
});

const SYSTEM_PROMPT = `You draft one SMS template for Stonegate Home Buyers.

Return a concise draft message and a short rationale. Use only these optional Handlebars variables: {{first_name}}, {{owner_name}}, {{property_address}}, {{street_name}}, {{city}}, {{state}}, {{county}}, {{acreage}}, and {{property_type}}. You may use a simple {{#if variable}}...{{/if}} block. Do not use any other variables or helpers.

This is drafting assistance, not a compliance determination. Do not claim consent, invent homeowner or property facts, or imply that a message has already been approved. Follow the operator's instructions while keeping the copy truthful and suitable for human review. Never include real contact data.`;

export interface OpenAITemplateDraft {
  body: string;
  rationale: string;
  responseId: string;
  model: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
}

export interface DraftSmsTemplateInput {
  instructions: string;
  existingBody?: string | null;
}

export interface DraftSmsTemplateOptions {
  client?: OpenAI;
  env?: Pick<
    AppEnv,
    "OPENAI_API_KEY" | "OPENAI_MODEL" | "OPENAI_TEMPLATE_DRAFTING_ENABLED"
  >;
}

export async function draftSmsTemplateWithOpenAI(
  input: DraftSmsTemplateInput,
  options: DraftSmsTemplateOptions = {},
): Promise<OpenAITemplateDraft> {
  const env = options.env ?? getEnv();
  if (!env.OPENAI_TEMPLATE_DRAFTING_ENABLED) {
    throw new Error("OpenAI template drafting is disabled");
  }
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const client =
    options.client ??
    new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      maxRetries: 2,
      timeout: 60_000,
    });
  const existingBody = input.existingBody?.trim();
  const response = await client.responses.parse({
    model: env.OPENAI_MODEL,
    max_output_tokens: 1_200,
    reasoning: { effort: "low" },
    store: false,
    input: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `Operator instructions:\n${input.instructions.trim()}`,
          existingBody
            ? `Existing template for context only:\n${existingBody}`
            : "There is no existing template body.",
        ].join("\n\n"),
      },
    ],
    text: {
      format: zodTextFormat(generatedDraftSchema, "sms_template_draft"),
    },
  });
  const draft = response.output_parsed;
  if (!draft) {
    throw new Error("OpenAI did not return a usable SMS template draft");
  }
  const validation = validateSmsTemplate(draft.body);
  if (!validation.valid) {
    throw new Error(
      `OpenAI returned an invalid SMS template: ${validation.error}`,
    );
  }

  return {
    body: draft.body,
    rationale: draft.rationale,
    responseId: response.id,
    model: response.model ?? env.OPENAI_MODEL,
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      totalTokens: response.usage?.total_tokens ?? null,
    },
  };
}
