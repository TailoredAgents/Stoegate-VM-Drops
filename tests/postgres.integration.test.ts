import { createHash, randomUUID } from "node:crypto";

import type {
  CampaignContactStatus,
  OutreachSequenceState,
  SmsMessageStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  importColdCallOutcomes,
  previewColdCallOutcomes,
} from "@/lib/outcome-imports";
import {
  createOutreachExport,
  getOutreachExportCsv,
} from "@/lib/outreach-exports";
import {
  persistDryRunSmsResult,
  persistLiveSmsProviderResult,
} from "@/lib/sms-operations";
import { recordSmsInboundMessage } from "@/lib/sms-conversations";
import { ensureSmsSequenceTx, reconcileSmsOutreach } from "@/lib/sms-outreach";
import {
  processCanonicalSmsWebhook,
  reconcileSynchronousSmsProviderResults,
} from "@/lib/sms-webhooks";
import { DryRunSMSProvider } from "@/providers/sms-dry-run";

const prefix = `sms-integration-${randomUUID()}`;
const providerKey = `${prefix}-provider`;
const senderPhone = "+12025550999";
const templateBody =
  "Hi {{first_name}}, are you open to an offer for {{property_address}}?";
const phoneAreaCodes = ["202", "212", "305", "312", "404", "512", "617", "770"];
let phoneSlot = Number.parseInt(randomUUID().slice(0, 6), 16) % 800;

let adminId = "";
let campaignId = "";
let templateId = "";
let templateVersionId = "";
const contactIds: string[] = [];
const propertyIds: string[] = [];
const phones: string[] = [];

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function addHours(value: Date, hours: number) {
  return new Date(value.getTime() + hours * 60 * 60 * 1000);
}

async function nextUnusedPhone() {
  for (let attempt = 0; attempt < 800; attempt += 1) {
    const slot = (phoneSlot + attempt) % 800;
    const areaCode = phoneAreaCodes[Math.floor(slot / 100)];
    const lineNumber = String(100 + (slot % 100)).padStart(4, "0");
    const phone = `+1${areaCode}555${lineNumber}`;
    const exists = await db.contact.findUnique({
      where: { normalizedPhone: phone },
      select: { id: true },
    });
    if (!exists) {
      phoneSlot = slot + 1;
      phones.push(phone);
      return phone;
    }
  }
  throw new Error("Could not reserve an unused integration-test phone");
}

interface SmsFixtureOptions {
  anchor?: Date;
  contact?: { id: string; phone: string };
  messageStatus?: SmsMessageStatus;
  campaignContactStatus?: CampaignContactStatus;
  sequenceState?: OutreachSequenceState;
  providerMessageId?: string;
  acceptedAt?: Date | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  smsSentAt?: Date | null;
  coldCallDueAt?: Date | null;
  coldCallEligibleAt?: Date | null;
}

async function createSmsFixture(
  label: string,
  options: SmsFixtureOptions = {},
) {
  const anchor = options.anchor ?? new Date("2030-01-01T15:00:00.000Z");
  const source = `${prefix}-${label}`;
  const existingContact = options.contact;
  const phone = existingContact?.phone ?? (await nextUnusedPhone());
  const contact = existingContact
    ? { id: existingContact.id, normalizedPhone: existingContact.phone }
    : await db.contact.create({
        data: {
          normalizedPhone: phone,
          firstName: "Sam",
          lastName: label,
          ownerName: `Sam ${label}`,
          source,
        },
      });
  if (!existingContact) contactIds.push(contact.id);

  const property = await db.property.create({
    data: {
      propertyAddress: `${propertyIds.length + 1} Integration Way`,
      streetName: "Integration Way",
      city: "Testville",
      state: "VA",
      postalCode: "22101",
      county: "Fairfax",
      propertyType: "House",
      source,
    },
  });
  propertyIds.push(property.id);

  const campaignContact = await db.campaignContact.create({
    data: {
      campaignId,
      contactId: contact.id,
      propertyId: property.id,
      status: options.campaignContactStatus ?? "QUEUED",
      selectedForSend: true,
      renderedText: `Hi Sam, are you open to an offer for ${property.propertyAddress}?`,
    },
  });
  const sequence = await db.$transaction((tx) =>
    ensureSmsSequenceTx(tx, campaignContact.id, 48),
  );
  const smsSentAt = options.smsSentAt ?? options.sentAt ?? null;
  const coldCallDueAt =
    options.coldCallDueAt === undefined
      ? smsSentAt
        ? addHours(smsSentAt, 48)
        : null
      : options.coldCallDueAt;
  const sequenceState = options.sequenceState ?? "SMS_QUEUED";
  const updatedSequence = await db.outreachSequence.update({
    where: { id: sequence.id },
    data: {
      currentState: sequenceState,
      smsScheduledFor: anchor,
      smsSentAt,
      smsToColdCallDelayHours: 48,
      coldCallDueAt,
      coldCallEligibleAt: options.coldCallEligibleAt ?? null,
      nextEligibleAt:
        sequenceState === "COLD_CALL_ELIGIBLE" ? null : coldCallDueAt,
      terminalAt: null,
      terminalReason: null,
      lastEventAt: anchor,
    },
  });

  const consent = await db.smsConsentEvidence.create({
    data: {
      contactId: contact.id,
      campaignId,
      campaignContactId: campaignContact.id,
      normalizedPhone: phone,
      status: "VERIFIED",
      basis: "EXPRESS_WRITTEN",
      source: "integration_test",
      disclosureText: "Integration-only consent fixture",
      evidence: { test: true, label },
      capturedAt: addHours(anchor, -24),
      createdByUserId: adminId,
    },
  });
  const renderedBody = `Hi Sam, are you open to an offer for ${property.propertyAddress}?`;
  const messageStatus = options.messageStatus ?? "QUEUED";
  const message = await db.smsOutboundMessage.create({
    data: {
      campaignContactId: campaignContact.id,
      sequenceId: updatedSequence.id,
      templateVersionId,
      consentEvidenceId: consent.id,
      sequenceNumber: 1,
      idempotencyKey: `${prefix}:${label}:message`,
      toPhone: phone,
      fromPhone: senderPhone,
      renderedBody,
      bodyHash: sha256(renderedBody),
      segmentCount: 1,
      estimatedCostMicros: 800,
      currency: "USD",
      complianceSnapshot: { consentEvidenceId: consent.id, test: true },
      suppressionCheckedAt: anchor,
      scheduledFor: anchor,
      queuedAt: anchor,
      providerKey: options.providerMessageId ? providerKey : null,
      providerMessageId: options.providerMessageId,
      providerStatus: options.providerMessageId
        ? messageStatus.toLowerCase()
        : null,
      status: messageStatus,
      acceptedAt: options.acceptedAt ?? null,
      sentAt: options.sentAt ?? null,
      deliveredAt: options.deliveredAt ?? null,
    },
  });

  return {
    source,
    phone,
    contactId: contact.id,
    propertyId: property.id,
    campaignContactId: campaignContact.id,
    sequenceId: updatedSequence.id,
    consentId: consent.id,
    messageId: message.id,
  };
}

beforeAll(async () => {
  await db.$queryRaw`SELECT 1`;
  const admin = await db.user.create({
    data: {
      email: `${prefix}@example.com`,
      passwordHash: "integration-only-not-a-login",
      role: "ADMIN",
    },
  });
  adminId = admin.id;

  const template = await db.smsTemplate.create({
    data: {
      name: `${prefix}-template`,
      description: "SMS integration template",
      createdByUserId: admin.id,
      versions: {
        create: {
          version: 1,
          body: templateBody,
          contentHash: sha256(templateBody),
          status: "APPROVED",
          createdByUserId: admin.id,
          approvedByUserId: admin.id,
          approvedAt: new Date("2029-12-01T15:00:00.000Z"),
        },
      },
    },
    include: { versions: true },
  });
  templateId = template.id;
  templateVersionId = template.versions[0].id;

  const campaign = await db.campaign.create({
    data: {
      name: `${prefix}-campaign`,
      sourceName: `${prefix}-campaign-source`,
      kind: "SMS",
      status: "SENDING",
      sendLimit: 100,
      smsDailyCap: 100,
      smsTemplateVersionId: templateVersionId,
      smsProviderKey: providerKey,
      smsSenderRef: senderPhone,
      smsProviderConfig: { test: true },
      smsCostConfig: { costPerSegmentMicros: 800 },
      smsScheduleTimezone: "America/New_York",
      smsEstimatedCostPerSegmentMicros: 800,
      smsCurrency: "USD",
      smsComplianceStatus: "APPROVED",
      smsComplianceNotes: "Integration-only approved fixture",
      smsColdCallDelayHours: 48,
      createdByUserId: admin.id,
      approvedAt: new Date("2029-12-01T16:00:00.000Z"),
      approvedByUserId: admin.id,
      launchedAt: new Date("2029-12-02T15:00:00.000Z"),
      launchedByUserId: admin.id,
    },
  });
  campaignId = campaign.id;
});

afterAll(async () => {
  try {
    const outcomeImportIds = (
      await db.externalOutcomeImport.findMany({
        where: { fileName: { startsWith: prefix } },
        select: { id: true },
      })
    ).map((row) => row.id);
    if (outcomeImportIds.length) {
      await db.smsAuditEvent.deleteMany({
        where: {
          entityType: "ExternalOutcomeImport",
          entityId: { in: outcomeImportIds },
        },
      });
      await db.externalOutcomeImport.deleteMany({
        where: { id: { in: outcomeImportIds } },
      });
    }
    const dailyUsageIds = campaignId
      ? (
          await db.smsDailyUsage.findMany({
            where: {
              entries: {
                some: {
                  message: {
                    campaignContact: { campaignId },
                  },
                },
              },
            },
            select: { id: true },
          })
        ).map((row) => row.id)
      : [];

    if (campaignId) {
      await db.outreachExport.deleteMany({
        where: { idempotencyKey: { startsWith: prefix } },
      });
      await db.smsAuditEvent.deleteMany({ where: { campaignId } });
    }
    await db.smsInboundMessage.deleteMany({ where: { providerKey } });
    await db.smsStatusEvent.deleteMany({ where: { providerKey } });
    if (phones.length)
      await db.suppressionEntry.deleteMany({
        where: { normalizedPhone: { in: phones } },
      });
    if (campaignId) await db.campaign.delete({ where: { id: campaignId } });
    if (dailyUsageIds.length)
      await db.smsDailyUsage.deleteMany({
        where: { id: { in: dailyUsageIds }, entries: { none: {} } },
      });
    if (contactIds.length)
      await db.contact.deleteMany({ where: { id: { in: contactIds } } });
    if (propertyIds.length)
      await db.property.deleteMany({ where: { id: { in: propertyIds } } });
    if (templateId) await db.smsTemplate.delete({ where: { id: templateId } });
    if (adminId) await db.user.delete({ where: { id: adminId } });
  } finally {
    await db.$disconnect();
  }
});

describe("SMS-first PostgreSQL application integration", () => {
  it("persists the approved template, campaign, consent, sequence, and message graph", async () => {
    const fixture = await createSmsFixture("schema-graph");
    const graph = await db.campaignContact.findUniqueOrThrow({
      where: { id: fixture.campaignContactId },
      include: {
        campaign: {
          include: {
            smsTemplateVersion: { include: { template: true } },
          },
        },
        contact: true,
        property: true,
        outreachSequence: true,
        consentEvidence: true,
        outboundMessages: {
          include: { templateVersion: true, consentEvidence: true },
        },
      },
    });

    expect(graph).toMatchObject({
      id: fixture.campaignContactId,
      selectedForSend: true,
      contact: { normalizedPhone: fixture.phone },
      property: { county: "Fairfax", state: "VA" },
      campaign: {
        kind: "SMS",
        smsComplianceStatus: "APPROVED",
        smsTemplateVersion: {
          id: templateVersionId,
          status: "APPROVED",
          contentHash: sha256(templateBody),
          template: { id: templateId, active: true },
        },
      },
      outreachSequence: {
        currentState: "SMS_QUEUED",
        smsToColdCallDelayHours: 48,
      },
    });
    expect(graph.consentEvidence).toHaveLength(1);
    expect(graph.outboundMessages).toHaveLength(1);
    expect(graph.outboundMessages[0]).toMatchObject({
      templateVersionId,
      consentEvidenceId: fixture.consentId,
      toPhone: fixture.phone,
      fromPhone: senderPhone,
      status: "QUEUED",
    });
  });

  it("persists a dry-run result once without attempts, usage, or a cold-call timer", async () => {
    const fixture = await createSmsFixture("dry-run");
    const provider = new DryRunSMSProvider();
    const request = {
      idempotencyKey: `${prefix}:dry-run:provider-call`,
      to: fixture.phone,
      from: senderPhone,
      body: "Integration dry-run body",
      clientReference: fixture.messageId,
    };
    const firstProviderResult = await provider.send(request);
    const replayedProviderResult = await provider.send(request);
    expect(replayedProviderResult).toMatchObject({
      providerMessageId: firstProviderResult.providerMessageId,
      requestFingerprint: firstProviderResult.requestFingerprint,
    });

    const firstPersistence = await persistDryRunSmsResult({
      messageId: fixture.messageId,
      providerMessageId: firstProviderResult.providerMessageId,
      rawResponse: firstProviderResult.rawResponse,
      requestFingerprint: firstProviderResult.requestFingerprint,
      occurredAt: new Date("2030-01-02T15:00:00.000Z"),
    });
    const replayedPersistence = await persistDryRunSmsResult({
      messageId: fixture.messageId,
      providerMessageId: firstProviderResult.providerMessageId,
      rawResponse: firstProviderResult.rawResponse,
      requestFingerprint: firstProviderResult.requestFingerprint,
      occurredAt: new Date("2030-01-02T15:01:00.000Z"),
    });

    expect(firstPersistence).toEqual({
      updated: true,
      reason: "recorded",
      messageStatus: "DRY_RUN",
    });
    expect(replayedPersistence).toEqual({
      updated: false,
      reason: "already_recorded",
      messageStatus: "DRY_RUN",
    });
    expect(
      await db.smsOutboundMessage.findUnique({
        where: { id: fixture.messageId },
      }),
    ).toMatchObject({
      status: "DRY_RUN",
      providerKey: "dry-run",
      actualCostMicros: 0,
      acceptedAt: null,
      sentAt: null,
    });
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({
      currentState: "SMS_DRY_RUN",
      smsSentAt: null,
      coldCallDueAt: null,
      coldCallEligibleAt: null,
      nextEligibleAt: null,
    });
    expect(
      await db.smsOutboundAttempt.count({
        where: { messageId: fixture.messageId },
      }),
    ).toBe(0);
    expect(
      await db.smsUsageLedger.count({
        where: { messageId: fixture.messageId },
      }),
    ).toBe(0);
    expect(
      await db.smsAuditEvent.count({
        where: {
          entityId: fixture.messageId,
          eventType: "SMS_DRY_RUN",
        },
      }),
    ).toBe(1);
  });

  it("recovers a synchronous provider delivery after a worker interruption without resending", async () => {
    const occurredAt = new Date("2030-01-03T15:00:00.000Z");
    const fixture = await createSmsFixture("synchronous-result-recovery", {
      anchor: occurredAt,
    });
    await db.$transaction([
      db.smsOutboundMessage.update({
        where: { id: fixture.messageId },
        data: {
          providerKey,
          status: "SUBMITTING",
          submissionStartedAt: occurredAt,
        },
      }),
      db.campaignContact.update({
        where: { id: fixture.campaignContactId },
        data: { status: "SENDING" },
      }),
      db.outreachSequence.update({
        where: { id: fixture.sequenceId },
        data: { currentState: "SMS_SENDING" },
      }),
    ]);
    const attempt = await db.smsOutboundAttempt.create({
      data: {
        messageId: fixture.messageId,
        attemptNumber: 1,
        idempotencyKey: `${prefix}:synchronous-result-recovery:attempt`,
        providerKey,
        status: "STARTED",
        startedAt: occurredAt,
      },
    });
    const providerMessageId = `${prefix}-synchronous-provider-message`;
    await persistLiveSmsProviderResult({
      messageId: fixture.messageId,
      attemptId: attempt.id,
      providerKey,
      outcome: "ACCEPTED",
      providerMessageId,
      providerStatus: "delivered",
      providerResponse: { status: "delivered", synchronous: true },
      occurredAt,
    });

    const recovered = await reconcileSynchronousSmsProviderResults();
    expect(recovered.recovered).toBeGreaterThanOrEqual(1);
    expect(
      await db.smsOutboundMessage.findUnique({
        where: { id: fixture.messageId },
      }),
    ).toMatchObject({
      status: "DELIVERED",
      providerMessageId,
      sentAt: occurredAt,
      deliveredAt: occurredAt,
    });
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({
      currentState: "SMS_DELIVERED",
      smsSentAt: occurredAt,
      coldCallDueAt: addHours(occurredAt, 48),
    });
    expect(
      await db.smsOutboundAttempt.count({
        where: { messageId: fixture.messageId },
      }),
    ).toBe(1);
  });

  it("makes an unanswered sent SMS cold-call eligible at exactly 48 hours", async () => {
    const sentAt = new Date("2030-01-03T15:00:00.000Z");
    const dueAt = addHours(sentAt, 48);
    const fixture = await createSmsFixture("forty-eight-hours", {
      anchor: sentAt,
      messageStatus: "SENT",
      campaignContactStatus: "SENT",
      sequenceState: "SMS_SENT",
      providerMessageId: `${prefix}-forty-eight-hours-message`,
      acceptedAt: sentAt,
      sentAt,
      smsSentAt: sentAt,
      coldCallDueAt: dueAt,
    });

    await reconcileSmsOutreach(new Date(dueAt.getTime() - 1));
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({
      currentState: "SMS_SENT",
      coldCallDueAt: dueAt,
      coldCallEligibleAt: null,
    });

    await reconcileSmsOutreach(dueAt);
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({
      currentState: "COLD_CALL_ELIGIBLE",
      coldCallDueAt: dueAt,
      coldCallEligibleAt: dueAt,
      nextEligibleAt: null,
    });
    expect(
      await db.outreachEvent.count({
        where: {
          sequenceId: fixture.sequenceId,
          type: "COLD_CALL_ELIGIBLE",
        },
      }),
    ).toBe(1);
  });

  it("matches an inbound reply to the newest reciprocal outbound and deduplicates provider delivery", async () => {
    const sentAt = new Date("2030-01-06T15:00:00.000Z");
    const fixture = await createSmsFixture("inbound-reply", {
      anchor: sentAt,
      messageStatus: "SENT",
      campaignContactStatus: "SENT",
      sequenceState: "SMS_SENT",
      providerMessageId: `${prefix}-inbound-outbound`,
      acceptedAt: sentAt,
      sentAt,
      smsSentAt: sentAt,
      coldCallDueAt: addHours(sentAt, 48),
    });
    const input = {
      providerKey: ` ${providerKey.toUpperCase()} `,
      providerMessageId: ` ${prefix}-inbound-provider-message `,
      providerConversationId: `${prefix}-conversation`,
      from: fixture.phone,
      to: senderPhone,
      body: "Yes, I am interested.",
      receivedAt: addHours(sentAt, 1),
      rawPayload: {
        id: `${prefix}-inbound-provider-message`,
        nested: { preserved: true },
      },
    };

    const first = await recordSmsInboundMessage(input);
    const replay = await recordSmsInboundMessage(input);

    expect(first).toMatchObject({
      matchedOutboundMessageId: fixture.messageId,
      duplicate: false,
      classification: "UNCLASSIFIED",
    });
    expect(replay).toMatchObject({
      messageId: first.messageId,
      conversationId: first.conversationId,
      matchedOutboundMessageId: fixture.messageId,
      duplicate: true,
    });
    expect(
      await db.smsInboundMessage.count({
        where: {
          providerKey,
          providerMessageId: `${prefix}-inbound-provider-message`,
        },
      }),
    ).toBe(1);
    expect(
      await db.smsInboundMessage.findUnique({ where: { id: first.messageId } }),
    ).toMatchObject({
      campaignContactId: fixture.campaignContactId,
      inReplyToMessageId: fixture.messageId,
      rawPayload: input.rawPayload,
    });
    expect(
      await db.smsConversation.findUnique({
        where: { campaignContactId: fixture.campaignContactId },
      }),
    ).toMatchObject({
      id: first.conversationId,
      providerKey,
      providerConversationId: `${prefix}-conversation`,
      status: "OPEN",
    });
    expect(
      await db.smsOutboundMessage.findUnique({
        where: { id: fixture.messageId },
      }),
    ).toMatchObject({ status: "REPLIED", repliedAt: input.receivedAt });
    expect(
      await db.outreachSequence.findUnique({
        where: { id: fixture.sequenceId },
      }),
    ).toMatchObject({
      currentState: "SMS_REPLIED",
      smsRespondedAt: input.receivedAt,
      coldCallDueAt: null,
      coldCallEligibleAt: null,
      nextEligibleAt: null,
    });
    expect(
      await db.campaignSuppression.findUnique({
        where: {
          campaignId_normalizedPhone: {
            campaignId,
            normalizedPhone: fixture.phone,
          },
        },
      }),
    ).toMatchObject({ reason: "COMPLIANCE" });
  });

  it("applies STOP as a global suppression and blocks every sequence for the phone", async () => {
    const sentAt = new Date("2030-01-07T15:00:00.000Z");
    const primary = await createSmsFixture("stop-primary", {
      anchor: sentAt,
      messageStatus: "DELIVERED",
      campaignContactStatus: "DELIVERED",
      sequenceState: "SMS_DELIVERED",
      providerMessageId: `${prefix}-stop-outbound`,
      acceptedAt: sentAt,
      sentAt,
      deliveredAt: addHours(sentAt, 1),
      smsSentAt: sentAt,
      coldCallDueAt: addHours(sentAt, 48),
    });
    const sibling = await createSmsFixture("stop-sibling", {
      anchor: sentAt,
      contact: { id: primary.contactId, phone: primary.phone },
      messageStatus: "SCHEDULED",
      campaignContactStatus: "QUEUED",
      sequenceState: "SMS_SCHEDULED",
      smsSentAt: null,
      coldCallDueAt: addHours(sentAt, 72),
    });

    const result = await recordSmsInboundMessage({
      providerKey,
      providerMessageId: `${prefix}-stop-inbound`,
      from: primary.phone,
      to: senderPhone,
      body: "STOP",
      receivedAt: addHours(sentAt, 2),
      rawPayload: { command: "STOP" },
    });

    expect(result).toMatchObject({
      matchedOutboundMessageId: primary.messageId,
      duplicate: false,
      classification: "OPT_OUT",
    });
    expect(
      await db.suppressionEntry.findUnique({
        where: { normalizedPhone: primary.phone },
      }),
    ).toMatchObject({ reason: "OPT_OUT", contactId: primary.contactId });
    expect(
      await db.campaignSuppression.findUnique({
        where: {
          campaignId_normalizedPhone: {
            campaignId,
            normalizedPhone: primary.phone,
          },
        },
      }),
    ).toMatchObject({ reason: "OPT_OUT" });
    expect(
      await db.outreachSequence.count({
        where: {
          campaignContactId: {
            in: [primary.campaignContactId, sibling.campaignContactId],
          },
          currentState: "OPT_OUT",
          terminalReason: "OPT_OUT",
          coldCallDueAt: null,
          coldCallEligibleAt: null,
          nextEligibleAt: null,
        },
      }),
    ).toBe(2);
    expect(
      await db.smsOutboundMessage.findUnique({
        where: { id: primary.messageId },
      }),
    ).toMatchObject({ status: "REPLIED" });
    expect(
      await db.smsOutboundMessage.findUnique({
        where: { id: sibling.messageId },
      }),
    ).toMatchObject({ status: "SUPPRESSED", errorCode: "OPT_OUT" });
    await reconcileSmsOutreach(addHours(sentAt, 240));
    expect(
      await db.outreachSequence.count({
        where: {
          campaignContactId: {
            in: [primary.campaignContactId, sibling.campaignContactId],
          },
          currentState: "COLD_CALL_ELIGIBLE",
        },
      }),
    ).toBe(0);
  });

  it("deduplicates delivery webhook events and ignores a status regression", async () => {
    const acceptedAt = new Date("2030-01-08T15:00:00.000Z");
    const providerMessageId = `${prefix}-delivery-message`;
    const fixture = await createSmsFixture("delivery-status", {
      anchor: acceptedAt,
      messageStatus: "ACCEPTED",
      campaignContactStatus: "ACCEPTED",
      sequenceState: "SMS_ACCEPTED",
      providerMessageId,
      acceptedAt,
      smsSentAt: acceptedAt,
      coldCallDueAt: addHours(acceptedAt, 48),
    });
    const deliveredAt = addHours(acceptedAt, 1);
    const deliveredEvent = {
      type: "delivery_status" as const,
      providerKey,
      providerEventId: `${prefix}-delivered-event`,
      providerMessageId,
      status: "delivered" as const,
      occurredAt: deliveredAt.toISOString(),
      segments: 2,
      costMicros: 1_700,
      currency: "USD",
    };

    const first = await processCanonicalSmsWebhook(deliveredEvent);
    const replay = await processCanonicalSmsWebhook(deliveredEvent);
    const lateSent = await processCanonicalSmsWebhook({
      ...deliveredEvent,
      providerEventId: `${prefix}-late-sent-event`,
      status: "sent",
      occurredAt: addHours(deliveredAt, 1).toISOString(),
    });

    expect(first).toMatchObject({
      matched: true,
      duplicate: false,
      applied: true,
      status: "DELIVERED",
    });
    expect(replay).toMatchObject({
      matched: true,
      duplicate: true,
      applied: false,
      status: "DELIVERED",
    });
    expect(lateSent).toMatchObject({
      matched: true,
      duplicate: false,
      applied: false,
      status: "DELIVERED",
    });
    expect(
      await db.smsStatusEvent.count({
        where: { messageId: fixture.messageId },
      }),
    ).toBe(2);
    expect(
      await db.smsOutboundMessage.findUnique({
        where: { id: fixture.messageId },
      }),
    ).toMatchObject({
      status: "DELIVERED",
      deliveredAt,
      actualSegmentCount: 2,
      actualCostMicros: 1_700,
    });
    expect(
      await db.smsUsageLedger.count({
        where: { messageId: fixture.messageId },
      }),
    ).toBe(2);
    expect(
      await db.smsAuditEvent.count({
        where: {
          entityId: fixture.messageId,
          eventType: "SMS_STATUS_IGNORED",
        },
      }),
    ).toBe(1);
  });

  it("uses the BatchDialer export claim to prevent an accidental duplicate export", async () => {
    const sentAt = new Date("2030-01-09T15:00:00.000Z");
    const eligibleAt = addHours(sentAt, 48);
    const fixture = await createSmsFixture("batch-claim", {
      anchor: sentAt,
      messageStatus: "SENT",
      campaignContactStatus: "SENT",
      sequenceState: "COLD_CALL_ELIGIBLE",
      providerMessageId: `${prefix}-batch-outbound`,
      acceptedAt: sentAt,
      sentAt,
      smsSentAt: sentAt,
      coldCallDueAt: eligibleAt,
      coldCallEligibleAt: eligibleAt,
    });
    const request = {
      type: "BATCH_DIALER" as const,
      campaignId,
      source: fixture.source,
      idempotencyKey: `${prefix}-batch-export-one`,
      user: { id: adminId, role: "ADMIN" as const },
    };

    const first = await createOutreachExport(request);
    const replay = await createOutreachExport(request);
    expect(first).toMatchObject({ itemCount: 1, type: "BATCH_DIALER" });
    expect(replay.id).toBe(first.id);
    expect(
      await db.outreachExportClaim.count({
        where: { sequenceId: fixture.sequenceId, type: "BATCH_DIALER" },
      }),
    ).toBe(1);
    expect(
      await db.outreachExportItem.count({
        where: { sequenceId: fixture.sequenceId },
      }),
    ).toBe(1);
    await expect(
      createOutreachExport({
        ...request,
        idempotencyKey: `${prefix}-batch-export-two`,
      }),
    ).rejects.toThrow(/eligible|already exported/i);
    expect(
      await db.outreachExport.count({
        where: { idempotencyKey: { startsWith: `${prefix}-batch-export` } },
      }),
    ).toBe(1);

    const firstHandoffAt = (
      await db.outreachSequence.findUniqueOrThrow({
        where: { id: fixture.sequenceId },
      })
    ).coldCallExportedAt;
    const repeated = await createOutreachExport({
      ...request,
      idempotencyKey: `${prefix}-batch-export-repeat`,
      intentionalRepeat: true,
      repeatReason: "Operator requested a second dialer file",
      confirmation: "RE-EXPORT",
    });
    expect(repeated).toMatchObject({
      itemCount: 1,
      intentionalRepeat: true,
    });
    expect(
      await db.outreachExportClaim.count({
        where: { sequenceId: fixture.sequenceId, type: "BATCH_DIALER" },
      }),
    ).toBe(1);
    expect(
      await db.outreachExportItem.findUniqueOrThrow({
        where: {
          exportId_sequenceId: {
            exportId: repeated.id,
            sequenceId: fixture.sequenceId,
          },
        },
      }),
    ).toMatchObject({ occurrence: 2 });
    expect(
      (
        await db.outreachSequence.findUniqueOrThrow({
          where: { id: fixture.sequenceId },
        })
      ).coldCallExportedAt,
    ).toEqual(firstHandoffAt);

    const download = await getOutreachExportCsv(first.id);
    expect(download?.filename).toMatch(/^stonegate-batchdialer-/);
    expect(download?.csv).toContain(fixture.phone);
    expect(download?.csv).toContain("Stonegate Campaign Contact ID");
  });

  it("imports a cold-call outcome idempotently without mutating another SMS sequence", async () => {
    const sentAt = new Date("2030-01-10T15:00:00.000Z");
    const eligibleAt = addHours(sentAt, 48);
    const target = await createSmsFixture("cold-call-import-target", {
      anchor: sentAt,
      messageStatus: "SENT",
      campaignContactStatus: "SENT",
      sequenceState: "COLD_CALL_ELIGIBLE",
      providerMessageId: `${prefix}-cold-call-import-outbound`,
      acceptedAt: sentAt,
      sentAt,
      smsSentAt: sentAt,
      coldCallDueAt: eligibleAt,
      coldCallEligibleAt: eligibleAt,
    });
    const untouched = await createSmsFixture("cold-call-import-untouched", {
      anchor: sentAt,
      contact: { id: target.contactId, phone: target.phone },
      sequenceState: "SMS_QUEUED",
    });
    const exportRecord = await createOutreachExport({
      type: "BATCH_DIALER",
      campaignId,
      source: target.source,
      idempotencyKey: `${prefix}-cold-call-import-export`,
      user: { id: adminId, role: "ADMIN" },
    });
    const bytes = Buffer.from(
      [
        "Stonegate Export ID,Stonegate Campaign Contact ID,Result,Occurred At,External ID",
        `${exportRecord.id},${target.campaignContactId},NO_ANSWER,2030-01-13T15:00:00.000Z,${prefix}-call-1`,
      ].join("\n"),
    );
    const preview = await previewColdCallOutcomes({ bytes });
    expect(preview).toMatchObject({ total: 1, ready: 1, rejected: 0 });
    const committed = await importColdCallOutcomes({
      fileName: `${prefix}-batchdialer-outcomes.csv`,
      bytes,
      userId: adminId,
      previewToken: preview.previewToken,
    });
    const replay = await importColdCallOutcomes({
      fileName: `${prefix}-batchdialer-outcomes.csv`,
      bytes,
      userId: adminId,
      previewToken: preview.previewToken,
    });
    expect(committed).toMatchObject({ accepted: 1, rejected: 0 });
    expect(replay.importId).toBe(committed.importId);
    expect(
      await db.outreachSequence.findUniqueOrThrow({
        where: { id: target.sequenceId },
      }),
    ).toMatchObject({ currentState: "COLD_CALL_NO_ANSWER" });
    expect(
      await db.outreachSequence.findUniqueOrThrow({
        where: { id: untouched.sequenceId },
      }),
    ).toMatchObject({ currentState: "SMS_QUEUED", terminalAt: null });
    expect(
      await db.leadAttribution.count({
        where: { campaignContactId: target.campaignContactId },
      }),
    ).toBe(0);
  });
});
