import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  transitionSmsSequenceTx: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/sms-outreach", () => ({
  transitionSmsSequenceTx: mocks.transitionSmsSequenceTx,
}));

import {
  classifySmsInboundMessage,
  recordSmsInboundMessage,
  selectMostRecentReplyCandidate,
  SMS_INBOUND_CLASSIFICATIONS,
  smsInboundClassificationPolicy,
  smsInboundProviderIdentity,
} from "./sms-conversations";

function makeTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    contact: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    smsInboundMessage: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "inbound-1" }),
      update: vi.fn().mockResolvedValue({ id: "inbound-1" }),
    },
    smsOutboundMessage: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ id: "outbound-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    smsConversation: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({ id: "conversation-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    suppressionEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "global-suppression-1" }),
    },
    campaignSuppression: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "campaign-suppression-1" }),
    },
    campaignContact: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    outreachSequence: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    outreachEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    leadAttribution: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "lead-1" }),
    },
    smsAuditEvent: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
  };
}

const receivedAt = new Date("2026-09-14T17:00:00.000Z");
const inboundInput = {
  providerKey: " Telnyx ",
  providerMessageId: " provider-message-1 ",
  from: "+15125550123",
  to: "+15125550999",
  body: "I would like to hear more.",
  receivedAt,
  rawPayload: {
    data: { id: "provider-message-1", nested: ["kept", 7] },
  },
};

const sequence = {
  id: "sequence-1",
  currentState: "SMS_SENT",
  smsRespondedAt: null,
  terminalAt: null,
  terminalReason: null,
};

function matchedOutbound() {
  return {
    id: "outbound-1",
    campaignContactId: "campaign-contact-1",
    createdAt: new Date("2026-09-14T16:00:00.000Z"),
    acceptedAt: new Date("2026-09-14T16:00:05.000Z"),
    sentAt: new Date("2026-09-14T16:00:10.000Z"),
    repliedAt: null,
    conversation: null,
    campaignContact: {
      campaignId: "campaign-1",
      contactId: "contact-1",
      contact: {
        id: "contact-1",
        normalizedPhone: "+15125550123",
      },
      outreachSequence: sequence,
      smsConversation: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transitionSmsSequenceTx.mockResolvedValue(true);
});

describe("SMS inbound identity and matching", () => {
  it("builds a stable provider/message identity without merging message IDs", () => {
    expect(smsInboundProviderIdentity(" Telnyx ", " message-1 ")).toBe(
      smsInboundProviderIdentity("telnyx", "message-1"),
    );
    expect(smsInboundProviderIdentity("telnyx", "message-1")).not.toBe(
      smsInboundProviderIdentity("telnyx", "message-2"),
    );
  });

  it("selects the newest reciprocal outbound message from the same provider", () => {
    const base = {
      providerKey: "telnyx",
      providerMessageId: "provider-outbound",
      toPhone: "+15125550123",
      fromPhone: "+15125550999",
      status: "SENT" as const,
      acceptedAt: null,
      sentAt: null,
    };
    const older = {
      ...base,
      id: "older",
      createdAt: new Date("2026-09-14T14:00:00.000Z"),
    };
    const newest = {
      ...base,
      id: "newest",
      status: "DELIVERED" as const,
      createdAt: new Date("2026-09-14T15:00:00.000Z"),
      sentAt: new Date("2026-09-14T16:00:00.000Z"),
    };
    const wrongProvider = {
      ...newest,
      id: "wrong-provider",
      providerKey: "other",
      sentAt: new Date("2026-09-14T16:30:00.000Z"),
    };
    const wrongDirection = {
      ...newest,
      id: "wrong-direction",
      toPhone: "+15125550999",
      fromPhone: "+15125550123",
    };
    const failed = {
      ...newest,
      id: "failed",
      status: "FAILED" as const,
    };

    expect(
      selectMostRecentReplyCandidate(
        [older, wrongProvider, failed, newest, wrongDirection],
        {
          providerKey: "telnyx",
          fromPhone: "+15125550123",
          toPhone: "+15125550999",
        },
      )?.id,
    ).toBe("newest");
  });

  it("records one row for duplicate provider delivery and preserves raw JSON", async () => {
    const tx = makeTx();
    let stored:
      | {
          id: string;
          conversationId: null;
          inReplyToMessageId: null;
          fromPhone: string;
          toPhone: string;
          body: string;
          classification: "UNCLASSIFIED";
        }
      | undefined;
    tx.smsInboundMessage.findUnique.mockImplementation(async () => stored);
    tx.smsInboundMessage.create.mockImplementation(async ({ data }) => {
      stored = {
        id: "inbound-1",
        conversationId: null,
        inReplyToMessageId: null,
        fromPhone: data.fromPhone,
        toPhone: data.toPhone,
        body: data.body,
        classification: "UNCLASSIFIED",
      };
      return stored;
    });
    mocks.transaction.mockImplementation(async (work) => work(tx));

    const first = await recordSmsInboundMessage(inboundInput);
    const duplicate = await recordSmsInboundMessage(inboundInput);

    expect(first.duplicate).toBe(false);
    expect(duplicate).toMatchObject({
      messageId: "inbound-1",
      duplicate: true,
      classification: "UNCLASSIFIED",
    });
    expect(tx.smsInboundMessage.create).toHaveBeenCalledTimes(1);
    expect(tx.smsAuditEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.smsInboundMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerKey: "telnyx",
        providerMessageId: "provider-message-1",
        rawPayload: inboundInput.rawPayload,
      }),
    });
    expect(tx.smsInboundMessage.findUnique).toHaveBeenCalledWith({
      where: {
        providerKey_providerMessageId: {
          providerKey: "telnyx",
          providerMessageId: "provider-message-1",
        },
      },
    });
  });
});

describe("SMS inbound safety effects", () => {
  it("upserts the conversation, marks the outbound reply, and blocks cold-call eligibility", async () => {
    const tx = makeTx();
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "outbound-1" }]);
    tx.smsOutboundMessage.findUnique.mockResolvedValue(matchedOutbound());
    tx.smsConversation.upsert.mockResolvedValue({
      id: "conversation-1",
      status: "OPEN",
    });
    tx.outreachSequence.findUnique.mockResolvedValue(sequence);
    mocks.transaction.mockImplementation(async (work) => work(tx));

    const result = await recordSmsInboundMessage(inboundInput);

    expect(result).toMatchObject({
      conversationId: "conversation-1",
      matchedOutboundMessageId: "outbound-1",
      duplicate: false,
      classification: "UNCLASSIFIED",
    });
    expect(tx.smsConversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { campaignContactId: "campaign-contact-1" },
        create: expect.objectContaining({
          campaignContactId: "campaign-contact-1",
          providerKey: "telnyx",
          status: "OPEN",
        }),
      }),
    );
    expect(tx.smsOutboundMessage.update).toHaveBeenCalledWith({
      where: { id: "outbound-1" },
      data: {
        conversationId: "conversation-1",
        status: "REPLIED",
        repliedAt: receivedAt,
      },
    });
    expect(tx.campaignSuppression.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: "COMPLIANCE" }),
      }),
    );
    expect(tx.smsOutboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["PENDING", "SCHEDULED", "QUEUED"] },
        }),
        data: expect.objectContaining({
          status: "SUPPRESSED",
          errorCode: "INBOUND_REPLY",
        }),
      }),
    );
    expect(mocks.transitionSmsSequenceTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sequenceId: "sequence-1",
        resultingState: "SMS_REPLIED",
        projection: expect.objectContaining({
          smsRespondedAt: receivedAt,
          terminalAt: receivedAt,
          coldCallDueAt: null,
          coldCallEligibleAt: null,
          nextEligibleAt: null,
        }),
      }),
    );
  });

  it("turns a STOP-equivalent reply into immediate global suppression", async () => {
    const tx = makeTx();
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "outbound-1" }]);
    tx.smsOutboundMessage.findUnique.mockResolvedValue(matchedOutbound());
    tx.smsConversation.upsert.mockResolvedValue({
      id: "conversation-1",
      status: "SUPPRESSED",
    });
    tx.contact.findUnique.mockResolvedValue({ id: "contact-1" });
    tx.campaignContact.findMany.mockResolvedValue([
      {
        id: "campaign-contact-1",
        campaignId: "campaign-1",
        contactId: "contact-1",
      },
    ]);
    tx.outreachSequence.findMany.mockResolvedValue([{ id: "sequence-1" }]);
    mocks.transaction.mockImplementation(async (work) => work(tx));

    await recordSmsInboundMessage({ ...inboundInput, body: "REMOVE ME" });

    expect(tx.smsInboundMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        classification: "OPT_OUT",
        classificationSource: "PROVIDER_OR_KEYWORD",
        isOptOut: true,
      }),
    });
    expect(tx.suppressionEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          normalizedPhone: "+15125550123",
          reason: "OPT_OUT",
        }),
      }),
    );
    expect(tx.campaignContact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "OPTED_OUT" }),
      }),
    );
    expect(tx.smsConversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUPPRESSED" }),
      }),
    );
    expect(tx.smsOutboundMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["PENDING", "SCHEDULED", "QUEUED"] },
        }),
      }),
    );
    expect(mocks.transitionSmsSequenceTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sequenceId: "sequence-1",
        resultingState: "OPT_OUT",
        projection: expect.objectContaining({
          coldCallDueAt: null,
          coldCallEligibleAt: null,
          nextEligibleAt: null,
        }),
      }),
    );
  });

  it("credits only a qualified classification as an SMS lead", async () => {
    const tx = makeTx();
    tx.smsInboundMessage.findUnique.mockResolvedValue({
      id: "819833b8-ce30-4331-b210-1a8c28964f37",
      fromPhone: "+15125550123",
      receivedAt,
      classification: "UNCLASSIFIED",
      classificationSource: null,
      isOptOut: false,
      conversation: { id: "conversation-1", status: "OPEN", closedAt: null },
      campaignContact: {
        id: "campaign-contact-1",
        campaignId: "campaign-1",
        contactId: "contact-1",
        contact: { normalizedPhone: "+15125550123" },
        outreachSequence: sequence,
      },
    });
    tx.outreachEvent.findUnique.mockResolvedValue({ id: "event-1" });
    tx.smsInboundMessage.update.mockResolvedValue({
      id: "819833b8-ce30-4331-b210-1a8c28964f37",
      classification: "QUALIFIED_LEAD",
    });
    mocks.transaction.mockImplementation(async (work) => work(tx));

    await classifySmsInboundMessage({
      messageId: "819833b8-ce30-4331-b210-1a8c28964f37",
      classification: "QUALIFIED_LEAD",
      actorUserId: "45e072db-93de-46c6-b114-27fd403d33c9",
    });

    expect(tx.leadAttribution.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        campaignContactId: "campaign-contact-1",
        campaignId: "campaign-1",
        creditedChannel: "SMS",
        creditedEventId: "event-1",
        qualifyingOutcome: "QUALIFIED_LEAD",
      }),
    });
    expect(tx.smsInboundMessage.update).toHaveBeenCalledWith({
      where: { id: "819833b8-ce30-4331-b210-1a8c28964f37" },
      data: expect.objectContaining({
        classification: "QUALIFIED_LEAD",
        classificationSource: "USER",
        classifiedByUserId: "45e072db-93de-46c6-b114-27fd403d33c9",
      }),
    });
  });
});

describe("SMS classification policy", () => {
  it("covers every persisted classification and maps the safety outcomes", () => {
    expect(new Set(SMS_INBOUND_CLASSIFICATIONS).size).toBe(13);
    for (const classification of SMS_INBOUND_CLASSIFICATIONS)
      expect(smsInboundClassificationPolicy(classification)).toBeDefined();

    expect(smsInboundClassificationPolicy("QUALIFIED_LEAD")).toMatchObject({
      sequenceState: "QUALIFIED_LEAD",
      createsLead: true,
      globalSuppression: null,
    });
    expect(smsInboundClassificationPolicy("WRONG_NUMBER")).toMatchObject({
      sequenceState: "WRONG_NUMBER",
      globalSuppression: "WRONG_NUMBER",
    });
    expect(smsInboundClassificationPolicy("OPT_OUT")).toMatchObject({
      sequenceState: "OPT_OUT",
      globalSuppression: "OPT_OUT",
    });
    expect(smsInboundClassificationPolicy("OTHER")).toMatchObject({
      createsLead: false,
      globalSuppression: null,
    });
  });
});
