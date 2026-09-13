import { describe, expect, it } from "vitest";
import { renderVoicemailTemplate, validateTemplate } from "./templates";

describe("voicemail templates", () => {
  it("uses conditional fallbacks without broken spacing", () => {
    const template =
      "Hi {{#if first_name}}{{first_name}}{{else}}{{owner_name}}{{/if}}, calling{{#if city}} about {{city}}{{/if}}.";
    expect(
      renderVoicemailTemplate(template, {
        owner_name: "Jamie",
        city: "Canton",
      }),
    ).toBe("Hi Jamie, calling about Canton.");
    expect(renderVoicemailTemplate(template, { owner_name: "Jamie" })).toBe(
      "Hi Jamie, calling.",
    );
  });

  it("rejects malformed templates", () => {
    expect(validateTemplate("{{#if city}}oops").valid).toBe(false);
  });
});
