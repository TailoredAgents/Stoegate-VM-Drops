import { beforeEach, describe, expect, it, vi } from "vitest";

const deliveryEvent = { findUnique: vi.fn() };
const drop = { findUnique: vi.fn() };
vi.mock("@/lib/db", () => ({ db: { deliveryEvent, drop } }));

describe("webhook idempotency", () => {
  beforeEach(() => {
    deliveryEvent.findUnique.mockReset();
    drop.findUnique.mockReset();
  });

  it("stops duplicate events before mutating a drop", async () => {
    deliveryEvent.findUnique.mockResolvedValue({ id: "existing-event" });
    const { processDropCowboyWebhook } = await import("./webhooks");
    const result = await processDropCowboyWebhook({
      event_id: "evt-1",
      foreign_id: "drop-1",
      status: "delivered",
    });
    expect(result).toEqual({ duplicate: true, eventId: "existing-event" });
    expect(drop.findUnique).not.toHaveBeenCalled();
  });

  it("normalizes the official success payload and derives a stable event id", async () => {
    const { normalizeWebhookPayload } = await import("./webhooks");
    const payload = {
      drop_id: "provider-drop-1",
      foreign_id: "drop-1",
      phone_number: 2025550101,
      attempt_date: 1_700_000_000,
      status: "success",
      reason: "Delivered",
      dnc: false,
      product_cost: "0.03",
      compliance_fee: "0.01",
      tts_fee: 0,
      network: "carrier",
    };
    const first = normalizeWebhookPayload(payload);
    const second = normalizeWebhookPayload(payload);
    expect(first).toMatchObject({
      eventType: "success",
      foreignId: "drop-1",
      phone: "+12025550101",
      dnc: false,
      providerEventId: "provider-drop-1:success:1700000000",
    });
    expect(first.occurredAt?.toISOString()).toBe("2023-11-14T22:13:20.000Z");
    expect(second.providerEventId).toBe(first.providerEventId);
  });
});
