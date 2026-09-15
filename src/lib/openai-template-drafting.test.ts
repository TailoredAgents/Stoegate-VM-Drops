import { describe, expect, it, vi } from "vitest";

import { draftSmsTemplateWithOpenAI } from "./openai-template-drafting";

const enabledEnv = {
  OPENAI_API_KEY: "test-only-key",
  OPENAI_MODEL: "gpt-6-astra",
  OPENAI_TEMPLATE_DRAFTING_ENABLED: true,
};

function fakeClient(output: unknown) {
  const parse = vi.fn().mockResolvedValue(output);
  return { client: { responses: { parse } } as never, parse };
}

describe("OpenAI SMS template drafting", () => {
  it("requests structured drafting output without storing the response", async () => {
    const { client, parse } = fakeClient({
      id: "resp_test_1",
      model: "gpt-6-astra-2026-09-01",
      output_parsed: {
        body: "Hi {{first_name}}, would you consider an offer for {{property_address}}? Reply STOP to opt out.",
        rationale: "Concise, personalized outreach for operator review.",
      },
      usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
    });

    const result = await draftSmsTemplateWithOpenAI(
      {
        instructions: "Make the tone friendly and direct.",
        existingBody: "Hi {{first_name}}.",
      },
      { client, env: enabledEnv },
    );

    expect(result).toMatchObject({
      responseId: "resp_test_1",
      model: "gpt-6-astra-2026-09-01",
      usage: { totalTokens: 130 },
    });
    expect(parse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-6-astra",
        max_output_tokens: 1_200,
        reasoning: { effort: "low" },
        store: false,
        text: { format: expect.any(Object) },
      }),
    );
  });

  it("rejects a generated template with unsupported variables", async () => {
    const { client } = fakeClient({
      id: "resp_test_2",
      model: "gpt-6-astra",
      output_parsed: {
        body: "Hi {{secret_owner_fact}}",
        rationale: "Invalid test output.",
      },
      usage: null,
    });

    await expect(
      draftSmsTemplateWithOpenAI(
        { instructions: "Draft a message." },
        { client, env: enabledEnv },
      ),
    ).rejects.toThrow(/invalid SMS template/i);
  });

  it("does not call OpenAI when drafting is disabled", async () => {
    const { client, parse } = fakeClient({});

    await expect(
      draftSmsTemplateWithOpenAI(
        { instructions: "Draft a message." },
        {
          client,
          env: { ...enabledEnv, OPENAI_TEMPLATE_DRAFTING_ENABLED: false },
        },
      ),
    ).rejects.toThrow(/disabled/i);
    expect(parse).not.toHaveBeenCalled();
  });
});
