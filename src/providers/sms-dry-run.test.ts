import { describe, expect, it, vi } from "vitest";

import { DryRunSMSProvider } from "./sms-dry-run";

describe("DryRunSMSProvider", () => {
  it("is network-free and deterministic across provider instances", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const input = {
      idempotencyKey: "campaign-contact-42:sms:1",
      to: "+15125550123",
      from: "+15125550999",
      body: "Hi Sam, are you interested?",
      clientReference: "campaign-contact-42",
    };

    const first = await new DryRunSMSProvider().send(input);
    const retry = await new DryRunSMSProvider().send(input);

    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      status: "dry_run",
      providerMessageId: expect.stringMatching(/^dry-sms-[a-f0-9]{24}$/),
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      rawResponse: { dryRun: true },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("keeps the retry ID stable but fingerprints conflicting content", async () => {
    const provider = new DryRunSMSProvider();
    const original = await provider.send({
      idempotencyKey: "stable-key",
      to: "+15125550123",
      body: "Original body",
    });
    const conflicting = await provider.send({
      idempotencyKey: "stable-key",
      to: "+15125550123",
      body: "Changed body",
    });

    expect(conflicting.providerMessageId).toBe(original.providerMessageId);
    expect(conflicting.requestFingerprint).not.toBe(
      original.requestFingerprint,
    );
  });

  it("produces different IDs for different idempotency keys", async () => {
    const provider = new DryRunSMSProvider();
    const first = await provider.send({
      idempotencyKey: "key-1",
      to: "+15125550123",
      body: "Same body",
    });
    const second = await provider.send({
      idempotencyKey: "key-2",
      to: "+15125550123",
      body: "Same body",
    });

    expect(first.providerMessageId).not.toBe(second.providerMessageId);
  });

  it("rejects incomplete dry-run requests", async () => {
    const provider = new DryRunSMSProvider();

    await expect(
      provider.send({ idempotencyKey: "", to: "+15125550123", body: "Hi" }),
    ).rejects.toThrow("idempotencyKey");
    await expect(
      provider.send({ idempotencyKey: "key", to: "", body: "Hi" }),
    ).rejects.toThrow("to");
    await expect(
      provider.send({
        idempotencyKey: "key",
        to: "+15125550123",
        body: "   ",
      }),
    ).rejects.toThrow("body");
  });
});
