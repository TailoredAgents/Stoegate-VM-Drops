import { describe, expect, it } from "vitest";
import {
  countQualifiedAttributionsByChannel,
  summarizeAttributedOutcomeStages,
} from "./analytics";

describe("distinct multi-touch outcome stages", () => {
  it("counts one credited RVM callback and preserves cumulative distinct stages", () => {
    expect(
      summarizeAttributedOutcomeStages([
        {
          campaignContactId: "rvm-contact",
          outcome: "CALLBACK",
          attributionChannel: "RVM_CALLBACK",
          creditedRvmCallback: true,
        },
        {
          campaignContactId: "rvm-contact",
          outcome: "QUALIFIED_LEAD",
          attributionChannel: "RVM_CALLBACK",
          creditedRvmCallback: true,
        },
        {
          campaignContactId: "rvm-contact",
          outcome: "CONTRACT",
          attributionChannel: "RVM_CALLBACK",
          creditedRvmCallback: true,
        },
      ]),
    ).toEqual({
      callbacks: 1,
      interested: 1,
      qualified: 1,
      contracts: 1,
      closed: 0,
    });
  });

  it("includes external-channel leads without treating them as RVM callbacks", () => {
    expect(
      summarizeAttributedOutcomeStages([
        {
          campaignContactId: "sms-contact",
          outcome: "qualified lead",
          attributionChannel: "SMS",
        },
        {
          campaignContactId: "cold-contact",
          outcome: "closed",
          attributionChannel: "COLD_CALL",
        },
        {
          campaignContactId: null,
          outcome: "qualified_lead",
          attributionChannel: "RVM_CALLBACK",
          creditedRvmCallback: true,
        },
      ]),
    ).toEqual({
      callbacks: 0,
      interested: 2,
      qualified: 2,
      contracts: 1,
      closed: 1,
    });
  });

  it("keeps interested sellers distinct from qualified leads", () => {
    expect(
      summarizeAttributedOutcomeStages([
        {
          campaignContactId: "interested-only",
          outcome: "interested",
          attributionChannel: "SMS",
        },
      ]),
    ).toMatchObject({ interested: 1, qualified: 0, contracts: 0, closed: 0 });
  });

  it("does not report an interested attribution as a qualified funnel lead", () => {
    const attributions = [
      {
        campaignContactId: "interested-only",
        creditedChannel: "SMS" as const,
      },
      {
        campaignContactId: "qualified-later",
        creditedChannel: "COLD_CALL" as const,
      },
    ];
    expect(
      countQualifiedAttributionsByChannel(attributions, ["qualified-later"]),
    ).toEqual({
      RVM_CALLBACK: 0,
      SMS: 0,
      COLD_CALL: 1,
      OTHER: 0,
    });
  });
});
