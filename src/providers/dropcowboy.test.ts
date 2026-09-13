import { afterEach, describe, expect, it, vi } from "vitest";
import { DropCowboyRVMProvider } from "./dropcowboy";

const config = {
  endpoint: "https://api.dropcowboy.com/v1/rvm",
  teamId: "team-1",
  secret: "secret-1",
  brandId: "brand-1",
  forwardingNumber: "+12025550199",
};

afterEach(() => vi.restoreAllMocks());

describe("Drop Cowboy current OpenAPI contract", () => {
  it("verifies the registered API brand and sends hosted MP3 fields without inventing a response id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              brand_id: "brand-1",
              company_name: "Stonegate",
              registered: true,
              api_allowed: true,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "success", id: "not-in-openapi" }),
          { status: 200 },
        ),
      );
    const provider = new DropCowboyRVMProvider(config);
    await provider.assertReadyForLiveSend();
    const result = await provider.send({
      foreignId: "drop-1",
      phoneNumber: "+12025550101",
      media: {
        strategy: "hosted_url",
        url: "https://r2.example/signed.mp3",
        audioType: "mp3",
      },
      postalCode: "22901",
      callbackUrl: "https://drops.example/api/webhooks/dropcowboy",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.dropcowboy.com/v1/brand",
    );
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      team_id: "team-1",
      secret: "secret-1",
      foreign_id: "drop-1",
      brand_id: "brand-1",
      phone_number: "+12025550101",
      audio_url: "https://r2.example/signed.mp3",
      audio_type: "mp3",
      forwarding_number: "+12025550199",
      postal_code: "22901",
      callback_url: "https://drops.example/api/webhooks/dropcowboy",
    });
    expect(result).toEqual({
      status: "queued",
      rawResponse: { status: "success", id: "not-in-openapi" },
    });
  });

  it("rejects a brand that is not registered and API-enabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { brand_id: "brand-1", registered: false, api_allowed: true },
        ]),
        { status: 200 },
      ),
    );
    await expect(
      new DropCowboyRVMProvider(config).assertReadyForLiveSend(),
    ).rejects.toThrow("not registered");
  });
});
