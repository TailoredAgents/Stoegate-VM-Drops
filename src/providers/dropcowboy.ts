import { z } from "zod";
import type { RVMProvider, RVMSendInput } from "./types";

const responseSchema = z
  .object({
    status: z.string(),
  })
  .loose();

const brandListSchema = z.array(
  z.object({
    brand_id: z.string(),
    company_name: z.string().optional(),
    dba_name: z.string().optional(),
    registered: z.boolean().optional(),
    api_allowed: z.boolean().optional(),
  }),
);

function siblingEndpoint(endpoint: string, resource: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/[^/]*\/?$/, "")}/${resource}`;
  return url.toString();
}

export class DropCowboyRVMProvider implements RVMProvider {
  readonly name = "dropcowboy";
  readonly live = true;
  private verifiedUntil = 0;

  constructor(
    private readonly config: {
      endpoint: string;
      teamId: string;
      secret: string;
      brandId: string;
      forwardingNumber: string;
    },
  ) {}

  async checkBrand() {
    const response = await fetch(
      siblingEndpoint(this.config.endpoint, "brand"),
      {
        headers: {
          "x-team-id": this.config.teamId,
          "x-secret": this.config.secret,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const raw: unknown = await response.json().catch(() => ({}));
    const parsed = brandListSchema.safeParse(raw);
    if (!response.ok || !parsed.success) {
      throw new Error(`Drop Cowboy brand lookup failed (${response.status})`);
    }
    const brand = parsed.data.find(
      (item) => item.brand_id === this.config.brandId,
    );
    if (!brand)
      throw new Error(
        "Configured Drop Cowboy brand was not returned by the account",
      );
    if (brand.registered !== true)
      throw new Error("Configured Drop Cowboy brand is not registered");
    if (brand.api_allowed !== true)
      throw new Error("Configured Drop Cowboy brand is not API-enabled");
    return brand;
  }

  async assertReadyForLiveSend(): Promise<void> {
    if (Date.now() < this.verifiedUntil) return;
    await this.checkBrand();
    this.verifiedUntil = Date.now() + 5 * 60_000;
  }

  async send(input: RVMSendInput) {
    const response = await fetch(this.config.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-team-id": this.config.teamId,
        "x-secret": this.config.secret,
      },
      body: JSON.stringify({
        team_id: this.config.teamId,
        secret: this.config.secret,
        foreign_id: input.foreignId,
        brand_id: this.config.brandId,
        phone_number: input.phoneNumber,
        ...(input.media.strategy === "hosted_url"
          ? { audio_url: input.media.url, audio_type: input.media.audioType }
          : { recording_id: input.media.recordingId }),
        forwarding_number: this.config.forwardingNumber,
        postal_code: input.postalCode || undefined,
        callback_url: input.callbackUrl,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const raw: unknown = await response.json().catch(() => ({}));
    const parsed = responseSchema.safeParse(raw);
    if (!response.ok || !parsed.success) {
      throw new Error(
        `Drop Cowboy request failed (${response.status}): ${JSON.stringify(raw)}`,
      );
    }
    return {
      status: "queued" as const,
      rawResponse: parsed.data,
    };
  }
}
