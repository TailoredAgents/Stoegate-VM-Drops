import { describe, expect, it } from "vitest";
import {
  type CreateOutreachExportInput,
  exportFilterSnapshot,
  exportRequestMatchesExisting,
} from "./outreach-exports";

const input = {
  type: "SMS_ELIGIBILITY",
  campaignId: "d5f41924-1c3b-4ce2-a85b-b8d1873ea30e",
  stage: "SMS_ELIGIBLE",
  date: "2026-09-14",
  source: "  County list  ",
  creditedChannel: "RVM_CALLBACK",
  idempotencyKey: "f2bb34aa-0775-48b9-8f87-2926f16217b5",
  user: {
    id: "8e48d110-f40d-4efb-8933-10273b58ca63",
    role: "ADMIN",
  },
} satisfies CreateOutreachExportInput;

describe("outreach export request identity", () => {
  it("captures every queue filter in a normalized snapshot", () => {
    expect(exportFilterSnapshot(input)).toEqual({
      campaignId: input.campaignId,
      stage: "SMS_ELIGIBLE",
      date: "2026-09-14",
      source: "County list",
      creditedChannel: "RVM_CALLBACK",
    });
  });

  it("accepts only the same payload for an existing idempotency key", () => {
    const existing = {
      type: input.type,
      campaignId: input.campaignId,
      createdByUserId: input.user.id,
      intentionalRepeat: false,
      repeatReason: null,
      filtersSnapshot: exportFilterSnapshot(input),
    };

    expect(exportRequestMatchesExisting(existing, input)).toBe(true);
    expect(
      exportRequestMatchesExisting(existing, {
        ...input,
        stage: "SMS_EXPORTED",
      }),
    ).toBe(false);
    expect(
      exportRequestMatchesExisting(existing, {
        ...input,
        user: { ...input.user, id: "9ea7dede-b133-4ea7-b8c4-e0e83f8e003b" },
      }),
    ).toBe(false);
  });
});
