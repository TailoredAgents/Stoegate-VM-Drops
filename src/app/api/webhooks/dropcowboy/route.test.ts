import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  process: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/lib/webhooks", () => ({
  processDropCowboyWebhook: mocks.process,
  verifyDropCowboySignature: mocks.verify,
}));

import { POST } from "./route";

describe("Drop Cowboy webhook route authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.process.mockResolvedValue({ eventId: "event-1", duplicate: false });
  });

  it("returns 503 and does not parse events when the server secret is unset", async () => {
    mocks.getEnv.mockReturnValue({ DROP_COWBOY_WEBHOOK_SECRET: undefined });
    const response = await POST(
      new Request("http://localhost/api/webhooks/dropcowboy", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(503);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("rejects a missing or invalid signature", async () => {
    mocks.getEnv.mockReturnValue({ DROP_COWBOY_WEBHOOK_SECRET: "secret" });
    mocks.verify.mockReturnValue(false);
    const response = await POST(
      new Request("http://localhost/api/webhooks/dropcowboy", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
  });
});
