import { describe, expect, it, vi } from "vitest";
import { DryRunRVMProvider } from "./dry-run";

describe("dry-run RVM provider", () => {
  it("never performs a provider network send", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await new DryRunRVMProvider().send({
      foreignId: "drop-1",
      phoneNumber: "+17705551234",
      media: { strategy: "hosted_url", url: "local", audioType: "mp3" },
      callbackUrl: "local",
    });
    expect(result.status).toBe("dry_run");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
