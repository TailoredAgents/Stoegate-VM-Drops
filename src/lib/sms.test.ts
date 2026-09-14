import { describe, expect, it } from "vitest";

import {
  estimateSmsProviderCost,
  estimateSmsSegments,
  prepareSmsMessage,
  renderSmsTemplate,
  resolveSmsTemplateContext,
  validateSmsTemplate,
} from "./sms";

describe("SMS template rendering", () => {
  it("renders the supported personalization fields without HTML escaping", () => {
    expect(
      renderSmsTemplate(
        "Hi {{first_name}} — is your {{acreage}}-acre {{property_type}} at {{property_address}} in {{city}}, {{state}} still available? - {{owner_name}}",
        {
          first_name: "Jo",
          owner_name: "R&D Home Buyers",
          property_address: "12 Oak St",
          city: "Austin",
          state: "TX",
          acreage: 2.5,
          property_type: "parcel",
        },
      ),
    ).toBe(
      "Hi Jo — is your 2.5-acre parcel at 12 Oak St in Austin, TX still available? - R&D Home Buyers",
    );
  });

  it("uses documented identity and property fallbacks", () => {
    expect(
      resolveSmsTemplateContext({
        owner_name: "Ada Lovelace",
        street_name: "Main Street",
      }),
    ).toMatchObject({
      first_name: "Ada",
      owner_name: "Ada Lovelace",
      property_address: "Main Street",
      street_name: "Main Street",
      city: "",
      state: "",
      county: "",
      acreage: "",
      property_type: "property",
    });

    expect(
      renderSmsTemplate(
        "Hi {{first_name}}, this is {{owner_name}} about {{property_address}}. Is the {{property_type}}{{#if city}} in {{city}}{{/if}} available?",
        {},
      ),
    ).toBe(
      "Hi there, this is there about your property. Is the property available?",
    );
  });

  it("rejects unknown variables and empty rendered messages", () => {
    expect(validateSmsTemplate("Hi {{frist_name}}")).toMatchObject({
      valid: false,
    });
    expect(() => renderSmsTemplate("{{city}}", {})).toThrow(
      "SMS template rendered an empty message",
    );
  });
});

describe("SMS segment estimation", () => {
  it("uses GSM-7 single and concatenated boundaries", () => {
    expect(estimateSmsSegments("A".repeat(160))).toMatchObject({
      encoding: "GSM_7",
      encodingUnitCount: 160,
      segmentCount: 1,
      unitsPerSegment: 160,
      isMultipart: false,
    });
    expect(estimateSmsSegments("A".repeat(161))).toMatchObject({
      encoding: "GSM_7",
      encodingUnitCount: 161,
      segmentCount: 2,
      unitsPerSegment: 153,
      isMultipart: true,
    });
  });

  it("counts GSM-7 extension characters as two septets", () => {
    expect(estimateSmsSegments("^".repeat(80))).toMatchObject({
      encoding: "GSM_7",
      characterCount: 80,
      encodingUnitCount: 160,
      segmentCount: 1,
    });
    expect(estimateSmsSegments("^".repeat(81))).toMatchObject({
      encoding: "GSM_7",
      encodingUnitCount: 162,
      segmentCount: 2,
    });
  });

  it("uses UTF-16 units and UCS-2 boundaries for Unicode content", () => {
    expect(estimateSmsSegments("漢".repeat(70))).toMatchObject({
      encoding: "UCS_2",
      encodingUnitCount: 70,
      segmentCount: 1,
    });
    expect(estimateSmsSegments("漢".repeat(71))).toMatchObject({
      encoding: "UCS_2",
      encodingUnitCount: 71,
      segmentCount: 2,
    });
    expect(estimateSmsSegments("😀".repeat(36))).toMatchObject({
      encoding: "UCS_2",
      characterCount: 36,
      encodingUnitCount: 72,
      segmentCount: 2,
    });
  });

  it("never truncates and emits a multi-segment warning", () => {
    const completeBody = "A".repeat(307);
    const prepared = prepareSmsMessage("{{property_address}}", {
      property_address: completeBody,
    });

    expect(prepared.body).toBe(completeBody);
    expect(prepared.segments).toMatchObject({
      segmentCount: 3,
      wasTruncated: false,
    });
    expect(prepared.segments.warnings).toContainEqual(
      expect.objectContaining({ code: "MULTI_SEGMENT" }),
    );
  });
});

describe("SMS provider cost estimation", () => {
  it("uses configuration-driven per-segment and fixed costs", () => {
    expect(
      estimateSmsProviderCost(3, {
        costPerSegmentCents: 0.79,
        fixedCostPerMessageCents: 0.25,
      }),
    ).toEqual({
      segmentCount: 3,
      segmentCostCents: 2.37,
      fixedCostCents: 0.25,
      estimatedProviderCostCents: 2.62,
    });
  });

  it("does not apply a fixed cost when there is no message", () => {
    expect(
      estimateSmsProviderCost(0, {
        costPerSegmentCents: 1,
        fixedCostPerMessageCents: 2,
      }).estimatedProviderCostCents,
    ).toBe(0);
  });

  it("rejects invalid segment counts and cost configuration", () => {
    expect(() =>
      estimateSmsProviderCost(1.5, { costPerSegmentCents: 1 }),
    ).toThrow("segmentCount");
    expect(() =>
      estimateSmsProviderCost(1, { costPerSegmentCents: -1 }),
    ).toThrow("costPerSegmentCents");
  });
});
