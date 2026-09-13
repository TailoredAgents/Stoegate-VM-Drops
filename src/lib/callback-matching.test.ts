import { describe, expect, it } from "vitest";
import { selectCallbackMatch } from "./callback-matching";

describe("callback matching", () => {
  const now = new Date();
  it("matches one recent property", () => {
    expect(
      selectCallbackMatch([
        { campaignContactId: "a", propertyId: "p1", deliveredAt: now },
      ]).status,
    ).toBe("matched");
  });

  it("returns ambiguity for one phone with multiple properties", () => {
    const result = selectCallbackMatch([
      { campaignContactId: "a", propertyId: "p1", deliveredAt: now },
      {
        campaignContactId: "b",
        propertyId: "p2",
        deliveredAt: new Date(now.getTime() - 1000),
      },
    ]);
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  it("collapses repeat drops for the same property to the newest", () => {
    const result = selectCallbackMatch([
      { campaignContactId: "new", propertyId: "p1", deliveredAt: now },
      {
        campaignContactId: "old",
        propertyId: "p1",
        deliveredAt: new Date(now.getTime() - 1000),
      },
    ]);
    expect(result.status).toBe("matched");
    expect(result.candidates[0].campaignContactId).toBe("new");
  });
});
