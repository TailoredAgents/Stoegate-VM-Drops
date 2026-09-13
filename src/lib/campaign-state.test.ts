import { describe, expect, it } from "vitest";
import {
  assertCampaignTransition,
  canTransitionCampaign,
} from "./campaign-state";

describe("campaign state transitions", () => {
  it("enforces preview approval before queueing", () => {
    expect(canTransitionCampaign("DATA_READY", "QUEUED")).toBe(false);
    expect(canTransitionCampaign("PREVIEW_READY", "APPROVED")).toBe(true);
    expect(canTransitionCampaign("APPROVED", "QUEUED")).toBe(true);
    expect(() => assertCampaignTransition("DRAFT", "SENDING")).toThrow(
      /Invalid campaign transition/,
    );
  });
});
