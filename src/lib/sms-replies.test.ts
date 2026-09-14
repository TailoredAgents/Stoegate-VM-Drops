import { describe, expect, it } from "vitest";
import {
  classificationCreatesLead,
  classificationCreatesSuppression,
  isSmsOptOutText,
} from "./sms-replies";

describe("SMS reply policy", () => {
  it.each([
    "STOP",
    "stop",
    "STOPALL",
    "unsubscribe",
    "CANCEL",
    "END",
    "QUIT",
    "stop!!!",
    "opt out",
    "remove me",
    "do not text",
    "don't text",
    "stop texting",
    "stop all",
    "no more texts",
    "please stop",
  ])("recognizes %s as an opt-out", (body) => {
    expect(isSmsOptOutText(body)).toBe(true);
  });

  it("does not infer opt-out from ordinary conversation", () => {
    expect(isSmsOptOutText("Please don't stop by today")).toBe(false);
    expect(isSmsOptOutText("Stop by tomorrow")).toBe(false);
    expect(isSmsOptOutText("Interested")).toBe(false);
  });

  it("maps only explicit policy outcomes to global suppression", () => {
    expect(classificationCreatesSuppression("OPT_OUT")).toBe("OPT_OUT");
    expect(classificationCreatesSuppression("WRONG_NUMBER")).toBe(
      "WRONG_NUMBER",
    );
    expect(classificationCreatesSuppression("NOT_INTERESTED")).toBeNull();
  });

  it("does not inflate qualified leads from merely interested replies", () => {
    expect(classificationCreatesLead("INTERESTED")).toBe(false);
    expect(classificationCreatesLead("QUALIFIED_LEAD")).toBe(true);
  });
});
