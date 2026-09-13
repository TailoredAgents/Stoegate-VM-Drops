import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as callbackLookupEndpoint } from "@/app/api/integrations/callback-lookup/route";
import { POST as callbackResultEndpoint } from "@/app/api/integrations/callback-result/route";
import { getCampaignMetrics } from "@/lib/analytics";
import { db } from "@/lib/db";
import { processDropCowboyWebhook } from "@/lib/webhooks";

const prefix = `integration-${randomUUID()}`;
const phones = ["+12025550101", "+12025550102", "+12025550103"];
const integrationHeaders = {
  authorization: "Bearer integration-test-api-key-32-chars",
  "content-type": "application/json",
};
let campaignId: string;
let contactIds: string[];
let campaignContactIds: string[];
let dropIds: string[];
let propertyIds: string[];
let adminId: string;

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
  const admin = await db.user.create({
    data: {
      email: `${prefix}@example.com`,
      passwordHash: "integration-only",
      role: "ADMIN",
    },
  });
  adminId = admin.id;
  const template = await db.scriptTemplate.create({
    data: {
      name: `${prefix}-template`,
      versions: { create: { version: 1, body: "Hello {{first_name}}" } },
    },
    include: { versions: true },
  });
  const voice = await db.voiceConfiguration.create({
    data: {
      name: `${prefix}-voice`,
      voiceId: "integration-voice",
      modelId: "integration-model",
    },
  });
  const campaign = await db.campaign.create({
    data: {
      name: `${prefix}-campaign`,
      status: "SENDING",
      sendLimit: 10,
      approvedAt: new Date(),
      launchedAt: new Date(),
      launchedByUserId: adminId,
      scriptTemplateVersionId: template.versions[0].id,
      voiceConfigurationId: voice.id,
    },
  });
  campaignId = campaign.id;
  const contacts = await Promise.all([
    db.contact.create({
      data: { normalizedPhone: phones[0], firstName: "Test" },
    }),
    db.contact.create({
      data: { normalizedPhone: phones[1], firstName: "Dnc" },
    }),
    db.contact.create({
      data: { normalizedPhone: phones[2], firstName: "Unique" },
    }),
  ]);
  contactIds = contacts.map((contact) => contact.id);

  campaignContactIds = [];
  dropIds = [];
  propertyIds = [];
  for (let index = 0; index < 5; index += 1) {
    const property = await db.property.create({
      data: {
        propertyAddress: `${index + 1} Test Street`,
        city: "Testville",
        state: "VA",
      },
    });
    propertyIds.push(property.id);
    const campaignContact = await db.campaignContact.create({
      data: {
        campaignId,
        contactId:
          index === 3
            ? contactIds[1]
            : index === 4
              ? contactIds[2]
              : contactIds[0],
        propertyId: property.id,
        status: "QUEUED",
        selectedForSend: true,
      },
    });
    const audio = await db.audioAsset.create({
      data: {
        campaignContactId: campaignContact.id,
        scriptTemplateVersionId: template.versions[0].id,
        voiceConfigurationId: voice.id,
        renderedText: `Hello ${index}`,
        textHash: `${prefix}-${index}`,
        voiceId: voice.voiceId,
        modelId: voice.modelId,
        characterCount: 7,
        objectKey: `${prefix}/${index}.mp3`,
        contentType: "audio/mpeg",
        status: "READY",
        generatedAt: new Date(),
      },
    });
    const delivered = index < 2 || index === 4;
    const drop = await db.drop.create({
      data: {
        campaignContactId: campaignContact.id,
        audioAssetId: audio.id,
        status: delivered ? "DELIVERED" : "QUEUED",
        queuedAt: new Date(),
        deliveredAt: delivered ? new Date(Date.now() - index * 1_000) : null,
      },
    });
    campaignContactIds.push(campaignContact.id);
    dropIds.push(drop.id);
  }
});

afterAll(async () => {
  await db.callbackOutcome.deleteMany({
    where: { idempotencyKey: { startsWith: prefix } },
  });
  await db.suppressionEntry.deleteMany({
    where: { normalizedPhone: { in: phones } },
  });
  await db.campaign.deleteMany({ where: { id: campaignId } });
  await db.contact.deleteMany({ where: { id: { in: contactIds } } });
  await db.property.deleteMany({ where: { id: { in: propertyIds } } });
  await db.voiceConfiguration.deleteMany({
    where: { name: `${prefix}-voice` },
  });
  await db.scriptTemplate.deleteMany({ where: { name: `${prefix}-template` } });
  await db.user.deleteMany({ where: { id: adminId } });
  await db.$disconnect();
});

describe("PostgreSQL application integration", () => {
  it("enforces the normalized phone uniqueness constraint", async () => {
    await expect(
      db.contact.create({ data: { normalizedPhone: phones[0] } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("returns not-found, a normalized unique match, and multi-property ambiguity through the lookup endpoint", async () => {
    const missing = await callbackLookupEndpoint(
      new Request(
        "http://localhost/api/integrations/callback-lookup?phone=2025550999",
        { headers: integrationHeaders },
      ),
    );
    expect(await missing.json()).toMatchObject({
      match_status: "not_found",
      phone: "+12025550999",
    });

    const unique = await callbackLookupEndpoint(
      new Request(
        "http://localhost/api/integrations/callback-lookup?phone=(202)%20555-0103",
        { headers: integrationHeaders },
      ),
    );
    expect(await unique.json()).toMatchObject({
      match_status: "matched",
      campaign_contact_id: campaignContactIds[4],
    });

    const ambiguous = await callbackLookupEndpoint(
      new Request(
        "http://localhost/api/integrations/callback-lookup?phone=202.555.0101",
        { headers: integrationHeaders },
      ),
    );
    const ambiguousBody = await ambiguous.json();
    expect(ambiguousBody).toMatchObject({ match_status: "ambiguous" });
    expect(ambiguousBody.candidates).toHaveLength(2);
  });

  it("requires explicit attribution when ambiguous, then stores repeat callbacks idempotently", async () => {
    const payload = {
      idempotency_key: `${prefix}-callback`,
      phone: phones[0],
      outcome: "opt_out" as const,
    };
    const ambiguous = await callbackResultEndpoint(
      new Request("http://localhost/api/integrations/callback-result", {
        method: "POST",
        headers: integrationHeaders,
        body: JSON.stringify(payload),
      }),
    );
    expect(ambiguous.status).toBe(400);
    expect(await ambiguous.json()).toMatchObject({
      error: expect.stringContaining("ambiguous"),
    });
    const attributed = {
      ...payload,
      campaign_contact_id: campaignContactIds[0],
    };
    const submit = () =>
      callbackResultEndpoint(
        new Request("http://localhost/api/integrations/callback-result", {
          method: "POST",
          headers: integrationHeaders,
          body: JSON.stringify(attributed),
        }),
      );
    expect(await (await submit()).json()).toMatchObject({
      ok: true,
      duplicate: false,
    });
    expect(await (await submit()).json()).toMatchObject({
      ok: true,
      duplicate: true,
    });
    expect(
      await db.callbackOutcome.count({
        where: { idempotencyKey: payload.idempotency_key },
      }),
    ).toBe(1);
    expect(
      await db.suppressionEntry.findUnique({
        where: { normalizedPhone: phones[0] },
      }),
    ).toMatchObject({ reason: "OPT_OUT" });
  });

  it("records normalized qualified-lead and not-interested callback outcomes with unique attribution", async () => {
    const qualified = await callbackResultEndpoint(
      new Request("http://localhost/api/integrations/callback-result", {
        method: "POST",
        headers: integrationHeaders,
        body: JSON.stringify({
          idempotency_key: `${prefix}-qualified`,
          phone: "(202) 555-0103",
          outcome: "qualified_lead",
        }),
      }),
    );
    expect(qualified.status).toBe(200);
    expect(
      await db.callbackOutcome.findUnique({
        where: { idempotencyKey: `${prefix}-qualified` },
      }),
    ).toMatchObject({
      normalizedPhone: phones[2],
      outcome: "QUALIFIED_LEAD",
      campaignId,
      campaignContactId: campaignContactIds[4],
    });

    await callbackResultEndpoint(
      new Request("http://localhost/api/integrations/callback-result", {
        method: "POST",
        headers: integrationHeaders,
        body: JSON.stringify({
          idempotency_key: `${prefix}-not-interested`,
          phone: "2025550103",
          outcome: "not_interested",
          campaign_contact_id: campaignContactIds[4],
        }),
      }),
    );
    expect(
      await db.callbackOutcome.findUnique({
        where: { idempotencyKey: `${prefix}-not-interested` },
      }),
    ).toMatchObject({ outcome: "NOT_INTERESTED" });
  });

  it("maps official success/failure payloads, deduplicates webhooks, and persists provider DNC", async () => {
    const success = {
      drop_id: `${prefix}-provider-drop`,
      foreign_id: dropIds[2],
      phone_number: phones[0],
      attempt_date: new Date().toISOString(),
      status: "success",
      dnc: false,
    };
    expect((await processDropCowboyWebhook(success)).duplicate).toBe(false);
    expect((await processDropCowboyWebhook(success)).duplicate).toBe(true);
    expect(
      await db.drop.findUnique({ where: { id: dropIds[2] } }),
    ).toMatchObject({ status: "DELIVERED" });

    const dnc = {
      drop_id: `${prefix}-provider-dnc`,
      foreign_id: dropIds[3],
      phone_number: phones[1],
      attempt_date: new Date().toISOString(),
      status: "failure",
      reason: "Internal DNC",
      dnc: true,
    };
    await processDropCowboyWebhook(dnc);
    expect(
      await db.drop.findUnique({ where: { id: dropIds[3] } }),
    ).toMatchObject({ status: "OPTED_OUT" });
    expect(
      await db.suppressionEntry.findUnique({
        where: { normalizedPhone: phones[1] },
      }),
    ).toMatchObject({ reason: "PROVIDER_DNC" });
  });

  it("calculates campaign response, lead, expected-deal, and VA-equivalent metrics from PostgreSQL", async () => {
    const metrics = await getCampaignMetrics(campaignId);
    expect(metrics).toMatchObject({
      callbacks: 3,
      interested: 1,
      qualified: 1,
      expectedDeals: 1 / 15,
      vaEquivalentConversations: 40,
    });
    expect(metrics.costPerExpectedDealCents).toBeGreaterThan(0);
  });
});

describe("pg-boss durability", () => {
  it("survives a producer restart and retries a failed PostgreSQL-backed job", async () => {
    const schema = `pgboss_test_${randomUUID().replaceAll("-", "")}`;
    const queue = `${prefix}-retry`;
    const producer = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema,
    });
    await producer.start();
    await producer.createQueue(queue, { retryLimit: 1, retryDelay: 1 });
    await producer.send(queue, { durable: true });
    await producer.stop({ graceful: true });

    const consumer = new PgBoss({
      connectionString: process.env.DATABASE_URL!,
      schema,
    });
    await consumer.start();
    let attempts = 0;
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for pg-boss retry")),
        20_000,
      );
      void consumer.work(
        queue,
        { pollingIntervalSeconds: 1 },
        async ([job]) => {
          attempts += 1;
          if (attempts === 1) throw new Error("intentional integration retry");
          expect(job.data).toEqual({ durable: true });
          clearTimeout(timer);
          resolve();
        },
      );
    });
    await completed;
    expect(attempts).toBe(2);
    await consumer.stop({ graceful: true });
    if (!/^pgboss_test_[a-f0-9]+$/.test(schema))
      throw new Error("Unsafe test schema name");
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});
