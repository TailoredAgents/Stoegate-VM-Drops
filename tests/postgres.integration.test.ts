import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as callbackLookupEndpoint } from "@/app/api/integrations/callback-lookup/route";
import { POST as callbackResultEndpoint } from "@/app/api/integrations/callback-result/route";
import { getCampaignMetrics } from "@/lib/analytics";
import { db } from "@/lib/db";
import { createOutreachExport } from "@/lib/outreach-exports";
import {
  ensureOutreachSequence,
  reconcileDueOutreach,
  recordExternalOutcomeTx,
  recordRvmSentTx,
} from "@/lib/outreach-service";
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
    const generatedAt = new Date();
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
        estimatedCostCents: 1,
        generatedAt,
      },
    });
    await db.audioGenerationUsage.create({
      data: {
        audioAssetId: audio.id,
        provider: "elevenlabs",
        characterCount: 7,
        estimatedCostCents: 1,
        billingDisposition: "BILLABLE_GENERATION",
        generatedAt,
        storedAt: generatedAt,
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
    await ensureOutreachSequence(campaignContact.id);
  }
});

afterAll(async () => {
  await db.callbackOutcome.deleteMany({
    where: { idempotencyKey: { startsWith: prefix } },
  });
  await db.outreachExport.deleteMany({
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

  it("stops every matching sequence when callback attribution is ambiguous and remains idempotent", async () => {
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
    expect(ambiguous.status).toBe(200);
    expect(await ambiguous.json()).toMatchObject({
      ok: true,
      duplicate: false,
    });
    const replay = () =>
      callbackResultEndpoint(
        new Request("http://localhost/api/integrations/callback-result", {
          method: "POST",
          headers: integrationHeaders,
          body: JSON.stringify(payload),
        }),
      );
    expect(await (await replay()).json()).toMatchObject({
      ok: true,
      duplicate: true,
    });
    const conflict = await callbackResultEndpoint(
      new Request("http://localhost/api/integrations/callback-result", {
        method: "POST",
        headers: integrationHeaders,
        body: JSON.stringify({
          ...payload,
          campaign_contact_id: campaignContactIds[0],
        }),
      }),
    );
    expect(conflict.status).toBe(400);
    expect(await conflict.json()).toMatchObject({
      error: expect.stringMatching(/idempotency key/i),
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
    expect(
      await db.outreachSequence.count({
        where: {
          currentState: "OPT_OUT",
          campaignContact: { contact: { normalizedPhone: phones[0] } },
        },
      }),
    ).toBe(3);
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
      callbacks: 1,
      interested: 1,
      qualified: 1,
      expectedDeals: 1 / 15,
      vaEquivalentConversations: 40,
    });
    expect(metrics.costPerExpectedDealCents).toBeGreaterThan(0);
  });
});

let outreachFixtureCounter = 100;

async function createOutreachFixture(label: string, anchor: Date) {
  outreachFixtureCounter += 1;
  const line = String(1000 + outreachFixtureCounter).slice(-4);
  const phone = `+1202555${line}`;
  const source = `${prefix}-${label}`;
  const contact = await db.contact.create({
    data: { normalizedPhone: phone, firstName: label, source },
  });
  contactIds.push(contact.id);
  const property = await db.property.create({
    data: {
      propertyAddress: `${outreachFixtureCounter} Sequence Way`,
      city: "Testville",
      state: "VA",
      postalCode: "22101",
      source,
    },
  });
  propertyIds.push(property.id);
  const campaignContact = await db.campaignContact.create({
    data: {
      campaignId,
      contactId: contact.id,
      propertyId: property.id,
      status: "QUEUED",
      selectedForSend: true,
    },
  });
  campaignContactIds.push(campaignContact.id);
  const template = await db.scriptTemplateVersion.findFirstOrThrow({
    where: { template: { name: `${prefix}-template` } },
  });
  const voice = await db.voiceConfiguration.findUniqueOrThrow({
    where: { name: `${prefix}-voice` },
  });
  const audio = await db.audioAsset.create({
    data: {
      campaignContactId: campaignContact.id,
      scriptTemplateVersionId: template.id,
      voiceConfigurationId: voice.id,
      renderedText: `Hello ${label}`,
      textHash: `${prefix}-${label}-${outreachFixtureCounter}`,
      voiceId: voice.voiceId,
      modelId: voice.modelId,
      characterCount: 10,
      objectKey: `${prefix}/${label}.mp3`,
      contentType: "audio/mpeg",
      status: "READY",
      billingDisposition: "DRY_RUN",
      generatedAt: anchor,
    },
  });
  const drop = await db.drop.create({
    data: {
      campaignContactId: campaignContact.id,
      audioAssetId: audio.id,
      status: "QUEUED",
      queuedAt: anchor,
    },
  });
  dropIds.push(drop.id);
  await ensureOutreachSequence(campaignContact.id, anchor);
  await db.$transaction((tx) =>
    recordRvmSentTx(tx, {
      campaignContactId: campaignContact.id,
      occurredAt: anchor,
      idempotencyKey: `${prefix}:${label}:rvm-sent`,
    }),
  );
  return {
    phone,
    source,
    contactId: contact.id,
    campaignContactId: campaignContact.id,
    sequenceId: (
      await db.outreachSequence.findUniqueOrThrow({
        where: { campaignContactId: campaignContact.id },
      })
    ).id,
    dropId: drop.id,
  };
}

async function advanceFixtureToSmsEligibility(
  fixture: Awaited<ReturnType<typeof createOutreachFixture>>,
  anchor: Date,
  label: string,
) {
  await processDropCowboyWebhook({
    drop_id: `${prefix}-${label}-provider`,
    foreign_id: fixture.dropId,
    phone_number: fixture.phone,
    attempt_date: anchor.toISOString(),
    status: "success",
    dnc: false,
  });
  await reconcileDueOutreach(new Date(anchor.getTime() + 24 * 60 * 60 * 1000));
}

async function exportFixtureForSms(
  fixture: Awaited<ReturnType<typeof createOutreachFixture>>,
  label: string,
) {
  return createOutreachExport({
    type: "SMS_ELIGIBILITY",
    campaignId,
    source: fixture.source,
    idempotencyKey: `${prefix}-${label}-sms-export`,
    user: { id: adminId, role: "ADMIN" },
  });
}

describe("durable outreach orchestration", () => {
  it("materializes RVM to SMS eligibility at 24 hours after a fresh reconciler start", async () => {
    const anchor = new Date("2026-09-20T14:00:00.000Z");
    const fixture = await createOutreachFixture("restart", anchor);
    await processDropCowboyWebhook({
      drop_id: `${prefix}-restart-provider`,
      foreign_id: fixture.dropId,
      phone_number: fixture.phone,
      attempt_date: anchor.toISOString(),
      status: "success",
      dnc: false,
    });
    const due = new Date(anchor.getTime() + 24 * 60 * 60 * 1000);
    await reconcileDueOutreach(new Date(due.getTime() - 1));
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({
      currentState: "SMS_NOT_YET_ELIGIBLE",
      nextEligibleAt: due,
    });
    const restartedReconciler = await reconcileDueOutreach(due);
    expect(restartedReconciler.smsEligible).toBeGreaterThanOrEqual(1);
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({ currentState: "SMS_ELIGIBLE", nextEligibleAt: null });
  });

  it("prevents SMS after a callback or qualified lead and preserves RVM attribution", async () => {
    const anchor = new Date("2026-09-21T14:00:00.000Z");
    const callbackFixture = await createOutreachFixture(
      "callback-stop",
      anchor,
    );
    await processDropCowboyWebhook({
      drop_id: `${prefix}-callback-stop-provider`,
      foreign_id: callbackFixture.dropId,
      phone_number: callbackFixture.phone,
      attempt_date: anchor.toISOString(),
      status: "success",
      dnc: false,
    });
    await callbackResultEndpoint(
      new Request("http://localhost/api/integrations/callback-result", {
        method: "POST",
        headers: integrationHeaders,
        body: JSON.stringify({
          idempotency_key: `${prefix}-callback-stop-result`,
          phone: callbackFixture.phone,
          outcome: "callback",
          campaign_contact_id: callbackFixture.campaignContactId,
        }),
      }),
    );
    await reconcileDueOutreach(
      new Date(anchor.getTime() + 30 * 60 * 60 * 1000),
    );
    expect(
      await db.outreachSequence.findUnique({
        where: { id: callbackFixture.sequenceId },
      }),
    ).toMatchObject({ currentState: "RVM_CALLBACK", nextEligibleAt: null });

    const leadFixture = await createOutreachFixture("qualified-stop", anchor);
    await callbackResultEndpoint(
      new Request("http://localhost/api/integrations/callback-result", {
        method: "POST",
        headers: integrationHeaders,
        body: JSON.stringify({
          idempotency_key: `${prefix}-qualified-stop-result`,
          phone: leadFixture.phone,
          outcome: "qualified_lead",
          campaign_contact_id: leadFixture.campaignContactId,
        }),
      }),
    );
    expect(
      await db.outreachSequence.findUnique({
        where: { id: leadFixture.sequenceId },
      }),
    ).toMatchObject({ currentState: "QUALIFIED_LEAD", nextEligibleAt: null });
    expect(
      await db.leadAttribution.findUnique({
        where: { campaignContactId: leadFixture.campaignContactId },
      }),
    ).toMatchObject({ creditedChannel: "RVM_CALLBACK" });
  });

  it("prevents cold-call eligibility after an SMS reply", async () => {
    const anchor = new Date("2026-09-22T14:00:00.000Z");
    const fixture = await createOutreachFixture("sms-reply", anchor);
    await advanceFixtureToSmsEligibility(fixture, anchor, "sms-reply");
    await exportFixtureForSms(fixture, "sms-reply");
    const sentAt = new Date(anchor.getTime() + 25 * 60 * 60 * 1000);
    await db.$transaction(async (tx) => {
      await recordExternalOutcomeTx(tx, {
        sequenceId: fixture.sequenceId,
        channel: "SMS",
        result: "sent",
        occurredAt: sentAt,
        idempotencyKey: `${prefix}:sms-reply:sent`,
      });
      await recordExternalOutcomeTx(tx, {
        sequenceId: fixture.sequenceId,
        channel: "SMS",
        result: "reply",
        occurredAt: new Date(sentAt.getTime() + 60 * 60 * 1000),
        idempotencyKey: `${prefix}:sms-reply:reply`,
      });
    });
    await reconcileDueOutreach(
      new Date(sentAt.getTime() + 72 * 60 * 60 * 1000),
    );
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({ currentState: "SMS_REPLIED", nextEligibleAt: null });
  });

  it("advances SMS no-response at 48 hours and blocks duplicate SMS and BatchDialer exports", async () => {
    const anchor = new Date("2026-09-23T14:00:00.000Z");
    const fixture = await createOutreachFixture("export-guard", anchor);
    await advanceFixtureToSmsEligibility(fixture, anchor, "export-guard");
    const user = { id: adminId, role: "ADMIN" as const };
    const smsExport = await createOutreachExport({
      type: "SMS_ELIGIBILITY",
      campaignId,
      source: fixture.source,
      idempotencyKey: `${prefix}-sms-export-1`,
      user,
    });
    expect(smsExport.itemCount).toBe(1);
    await expect(
      createOutreachExport({
        type: "SMS_ELIGIBILITY",
        campaignId,
        source: fixture.source,
        idempotencyKey: `${prefix}-sms-export-2`,
        user,
      }),
    ).rejects.toThrow(/eligible|already exported/i);
    const repeat = await createOutreachExport({
      type: "SMS_ELIGIBILITY",
      campaignId,
      source: fixture.source,
      idempotencyKey: `${prefix}-sms-export-repeat`,
      intentionalRepeat: true,
      repeatReason: "Controlled integration-test repeat",
      confirmation: "RE-EXPORT",
      user,
    });
    expect(repeat.intentionalRepeat).toBe(true);

    const sentAt = new Date(anchor.getTime() + 25 * 60 * 60 * 1000);
    await db.$transaction((tx) =>
      recordExternalOutcomeTx(tx, {
        sequenceId: fixture.sequenceId,
        channel: "SMS",
        result: "sent",
        occurredAt: sentAt,
        idempotencyKey: `${prefix}:export-guard:sent`,
      }),
    );
    const coldDue = new Date(sentAt.getTime() + 48 * 60 * 60 * 1000);
    await reconcileDueOutreach(new Date(coldDue.getTime() - 1));
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({ currentState: "SMS_SENT_EXTERNAL" });
    await reconcileDueOutreach(coldDue);
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({ currentState: "COLD_CALL_ELIGIBLE" });

    const batchExport = await createOutreachExport({
      type: "BATCH_DIALER",
      campaignId,
      source: fixture.source,
      idempotencyKey: `${prefix}-batch-export-1`,
      user,
    });
    expect(batchExport.itemCount).toBe(1);
    await expect(
      createOutreachExport({
        type: "BATCH_DIALER",
        campaignId,
        source: fixture.source,
        idempotencyKey: `${prefix}-batch-export-2`,
        user,
      }),
    ).rejects.toThrow(/eligible|already exported/i);
  });

  it("records the creating touch as SMS without changing it later", async () => {
    const anchor = new Date("2026-09-24T14:00:00.000Z");
    const fixture = await createOutreachFixture("sms-attribution", anchor);
    await advanceFixtureToSmsEligibility(fixture, anchor, "sms-attribution");
    await exportFixtureForSms(fixture, "sms-attribution");
    const sentAt = new Date(anchor.getTime() + 25 * 60 * 60 * 1000);
    await db.$transaction((tx) =>
      recordExternalOutcomeTx(tx, {
        sequenceId: fixture.sequenceId,
        channel: "SMS",
        result: "sent",
        occurredAt: sentAt,
        idempotencyKey: `${prefix}:sms-attribution:sent`,
      }),
    );
    await db.$transaction((tx) =>
      recordExternalOutcomeTx(tx, {
        sequenceId: fixture.sequenceId,
        channel: "SMS",
        result: "qualified lead",
        occurredAt: new Date(anchor.getTime() + 26 * 60 * 60 * 1000),
        idempotencyKey: `${prefix}:sms-attribution:qualified`,
      }),
    );
    expect(
      await db.leadAttribution.findUnique({
        where: { campaignContactId: fixture.campaignContactId },
      }),
    ).toMatchObject({ creditedChannel: "SMS" });
    await db.$transaction((tx) =>
      recordExternalOutcomeTx(tx, {
        sequenceId: fixture.sequenceId,
        channel: "SMS",
        result: "closed",
        occurredAt: new Date(anchor.getTime() + 27 * 60 * 60 * 1000),
        idempotencyKey: `${prefix}:sms-attribution:closed`,
      }),
    );
    expect(
      await db.leadAttribution.findUnique({
        where: { campaignContactId: fixture.campaignContactId },
      }),
    ).toMatchObject({ creditedChannel: "SMS" });
  });

  it("keeps a failed SMS out of cold-call eligibility and rejects skipped stages", async () => {
    const anchor = new Date("2026-09-25T14:00:00.000Z");
    const fixture = await createOutreachFixture("sms-failure", anchor);

    await expect(
      db.$transaction((tx) =>
        recordExternalOutcomeTx(tx, {
          sequenceId: fixture.sequenceId,
          channel: "SMS",
          result: "sent",
          occurredAt: new Date(anchor.getTime() + 60 * 60 * 1000),
          idempotencyKey: `${prefix}:sms-failure:invalid-sent`,
        }),
      ),
    ).rejects.toThrow(/successful RVM|exported for external SMS/i);

    await advanceFixtureToSmsEligibility(fixture, anchor, "sms-failure");
    await exportFixtureForSms(fixture, "sms-failure");
    const failedAt = new Date(anchor.getTime() + 25 * 60 * 60 * 1000);
    await db.$transaction((tx) =>
      recordExternalOutcomeTx(tx, {
        sequenceId: fixture.sequenceId,
        channel: "SMS",
        result: "failed",
        occurredAt: failedAt,
        idempotencyKey: `${prefix}:sms-failure:failed`,
      }),
    );
    await reconcileDueOutreach(
      new Date(failedAt.getTime() + 96 * 60 * 60 * 1000),
    );
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({
      currentState: "SMS_FAILED",
      smsSentAt: null,
      coldCallEligibleAt: null,
      nextEligibleAt: null,
    });
  });

  it("records late RVM webhooks without regressing the first final result", async () => {
    const deliveredAt = new Date("2026-09-26T14:00:00.000Z");
    const deliveredFixture = await createOutreachFixture(
      "ordered-delivery",
      deliveredAt,
    );
    await processDropCowboyWebhook({
      drop_id: `${prefix}-ordered-delivered`,
      foreign_id: deliveredFixture.dropId,
      phone_number: deliveredFixture.phone,
      attempt_date: deliveredAt.toISOString(),
      status: "success",
      dnc: false,
    });
    await processDropCowboyWebhook({
      drop_id: `${prefix}-ordered-late-sent`,
      foreign_id: deliveredFixture.dropId,
      phone_number: deliveredFixture.phone,
      attempt_date: new Date(deliveredAt.getTime() - 60_000).toISOString(),
      status: "sent",
      dnc: false,
    });
    await processDropCowboyWebhook({
      drop_id: `${prefix}-ordered-late-failure`,
      foreign_id: deliveredFixture.dropId,
      phone_number: deliveredFixture.phone,
      attempt_date: new Date(deliveredAt.getTime() + 60_000).toISOString(),
      status: "failure",
      dnc: false,
    });
    expect(
      await db.drop.findUnique({ where: { id: deliveredFixture.dropId } }),
    ).toMatchObject({ status: "DELIVERED", deliveredAt });
    expect(
      await db.outreachSequence.findUnique({
        where: { id: deliveredFixture.sequenceId },
      }),
    ).toMatchObject({ currentState: "SMS_NOT_YET_ELIGIBLE" });
    expect(
      await db.rvmUsageLedger.count({
        where: { dropId: deliveredFixture.dropId, kind: "SUCCESS" },
      }),
    ).toBe(1);

    const failedAt = new Date("2026-09-27T14:00:00.000Z");
    const failedFixture = await createOutreachFixture(
      "ordered-failure",
      failedAt,
    );
    await processDropCowboyWebhook({
      drop_id: `${prefix}-ordered-failed`,
      foreign_id: failedFixture.dropId,
      phone_number: failedFixture.phone,
      attempt_date: failedAt.toISOString(),
      status: "failure",
      dnc: false,
    });
    await processDropCowboyWebhook({
      drop_id: `${prefix}-ordered-late-delivery`,
      foreign_id: failedFixture.dropId,
      phone_number: failedFixture.phone,
      attempt_date: new Date(failedAt.getTime() + 60_000).toISOString(),
      status: "success",
      dnc: false,
    });
    expect(
      await db.drop.findUnique({ where: { id: failedFixture.dropId } }),
    ).toMatchObject({ status: "FAILED", failedAt });
    expect(
      await db.outreachSequence.findUnique({
        where: { id: failedFixture.sequenceId },
      }),
    ).toMatchObject({ currentState: "RVM_FAILED" });
    expect(
      await db.rvmUsageLedger.count({
        where: { dropId: failedFixture.dropId, kind: "SUCCESS" },
      }),
    ).toBe(0);
  });

  it("does not export a phone already attributed as a lead on another property", async () => {
    const anchor = new Date("2026-09-28T14:00:00.000Z");
    const fixture = await createOutreachFixture("known-lead", anchor);
    await advanceFixtureToSmsEligibility(fixture, anchor, "known-lead");
    const leadProperty = await db.property.create({
      data: {
        propertyAddress: "999 Prior Lead Lane",
        source: `${prefix}-prior-lead`,
      },
    });
    propertyIds.push(leadProperty.id);
    const priorLeadContact = await db.campaignContact.create({
      data: {
        campaignId,
        contactId: fixture.contactId,
        propertyId: leadProperty.id,
        status: "SKIPPED",
      },
    });
    campaignContactIds.push(priorLeadContact.id);
    await db.leadAttribution.create({
      data: {
        campaignContactId: priorLeadContact.id,
        campaignId,
        creditedChannel: "OTHER",
        qualifyingOutcome: "QUALIFIED_LEAD",
        attributedAt: anchor,
      },
    });

    await expect(exportFixtureForSms(fixture, "known-lead")).rejects.toThrow(
      /no eligible contacts/i,
    );
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
