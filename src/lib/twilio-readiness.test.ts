import { describe, expect, it, vi } from "vitest";

import type { AppEnv } from "./env";
import {
  acknowledgeTwilioProductionApproval,
  assertFreshTwilioReadiness,
  getTwilioReadinessStatus,
  runTwilioReadinessDiagnostic,
  twilioReadinessFingerprints,
  type TwilioDiagnosticClient,
  type TwilioReadinessDatabaseClient,
} from "./twilio-readiness";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const SERVICE_SID = `MG${"b".repeat(32)}`;
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-14T18:00:00.000Z");

const baseEnv: AppEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://example.invalid/stonegate_test",
  APP_BASE_URL: "https://sms.stonegate.example/app/path",
  SESSION_SECRET: "web-session-secret-at-least-32-characters",
  SESSION_TTL_HOURS: 12,
  OPENAI_MODEL: "gpt-6-astra",
  OPENAI_TEMPLATE_DRAFTING_ENABLED: false,
  SMS_LIVE_SENDS_ENABLED: true,
  SMS_PROVIDER: "twilio",
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: "high-entropy-test-auth-token",
  TWILIO_MESSAGING_SERVICE_SID: SERVICE_SID,
  TWILIO_PRODUCTION_APPROVED: true,
  DEFAULT_DAILY_SMS_LIMIT: 2_000,
  MAX_LIVE_SMS_CAMPAIGN_LIMIT: 10,
  MAX_LIVE_DAILY_SMS_LIMIT: 10,
  DEFAULT_SMS_TO_COLD_CALL_DELAY_HOURS: 48,
  PREVIEW_SAMPLE_SIZE: 10,
  WORKER_CONCURRENCY: 4,
  LOG_LEVEL: "silent",
};

const activeAdmin = {
  id: ADMIN_ID,
  email: "admin@stonegate.example",
  role: "ADMIN",
  active: true,
};

function passingDiagnosticClient(
  overrides: Partial<{
    account: Awaited<ReturnType<TwilioDiagnosticClient["fetchAccount"]>>;
    service: Awaited<ReturnType<TwilioDiagnosticClient["fetchService"]>>;
    senders: Awaited<ReturnType<TwilioDiagnosticClient["listPhoneNumbers"]>>;
    campaigns: Awaited<
      ReturnType<TwilioDiagnosticClient["listUsAppToPersonCampaigns"]>
    >;
  }> = {},
): TwilioDiagnosticClient {
  return {
    fetchAccount: vi.fn().mockResolvedValue(
      overrides.account ?? {
        sid: ACCOUNT_SID,
        status: "active",
        friendlyName: "Stonegate Home Buyers",
      },
    ),
    fetchService: vi.fn().mockResolvedValue(
      overrides.service ?? {
        sid: SERVICE_SID,
        accountSid: ACCOUNT_SID,
        friendlyName: "Stonegate outreach",
        inboundRequestUrl:
          "https://sms.stonegate.example/api/webhooks/twilio/inbound",
        inboundMethod: "POST",
        usecase: "marketing",
        usAppToPersonRegistered: true,
        useInboundWebhookOnNumber: false,
      },
    ),
    listPhoneNumbers: vi.fn().mockResolvedValue(
      overrides.senders ?? [
        {
          sid: `PN${"c".repeat(32)}`,
          accountSid: ACCOUNT_SID,
          serviceSid: SERVICE_SID,
          phoneNumber: "+15125550123",
          countryCode: "US",
          capabilities: ["SMS", "MMS", "Voice"],
        },
      ],
    ),
    listUsAppToPersonCampaigns: vi.fn().mockResolvedValue(
      overrides.campaigns ?? [
        {
          messagingServiceSid: SERVICE_SID,
          campaignStatus: "VERIFIED",
          campaignId: "C123",
        },
      ],
    ),
  };
}

function storeWithRecords(
  input: {
    diagnostic?: Record<string, unknown> | null;
    approval?: Record<string, unknown> | null;
    user?: typeof activeAdmin | null;
  } = {},
) {
  const diagnosticCreates: Array<Record<string, unknown>> = [];
  const approvalCreates: Array<Record<string, unknown>> = [];
  const store = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue(input.user === undefined ? activeAdmin : input.user),
    },
    providerDiagnosticRun: {
      findFirst: vi.fn().mockResolvedValue(input.diagnostic ?? null),
      create: vi.fn().mockImplementation(async ({ data }) => {
        diagnosticCreates.push(data);
        return {
          id: "diagnostic-created",
          createdAt: NOW,
          ...data,
        };
      }),
    },
    providerProductionApprovalEvent: {
      findFirst: vi.fn().mockResolvedValue(input.approval ?? null),
      create: vi.fn().mockImplementation(async ({ data }) => {
        approvalCreates.push(data);
        return {
          id: "approval-created",
          sequence: BigInt(1),
          ...data,
        };
      }),
    },
  };
  return {
    store: store as unknown as TwilioReadinessDatabaseClient,
    diagnosticCreates,
    approvalCreates,
  };
}

function passingRecords(env: AppEnv = baseEnv, now: Date = NOW) {
  const fingerprints = twilioReadinessFingerprints(env);
  const diagnostic = {
    id: "diagnostic-1",
    providerKey: "twilio",
    status: "PASSED",
    ...fingerprints,
    summary: "Twilio diagnostic passed.",
    details: {
      accountStatus: "active",
      senderCount: 1,
      usAppToPersonRegistered: true,
    },
    checkedAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 60_000),
    checkedByUserId: ADMIN_ID,
    createdAt: new Date(now.getTime() - 60_000),
    checkedBy: { email: activeAdmin.email },
  };
  const approval = {
    id: "approval-1",
    sequence: BigInt(1),
    providerKey: "twilio",
    decision: "APPROVED",
    configurationFingerprint: fingerprints.configurationFingerprint,
    diagnosticRunId: diagnostic.id,
    actorUserId: ADMIN_ID,
    note: "Approved",
    occurredAt: now,
    actor: {
      email: activeAdmin.email,
      active: true,
      role: "ADMIN",
    },
    diagnosticRun: {
      status: "PASSED",
      configurationFingerprint: fingerprints.configurationFingerprint,
      checkedAt: diagnostic.checkedAt,
    },
  };
  return { diagnostic, approval };
}

describe("Twilio readiness fingerprints", () => {
  it("matches between web and worker even when their session secrets differ", () => {
    const web = twilioReadinessFingerprints(baseEnv);
    const worker = twilioReadinessFingerprints({
      ...baseEnv,
      SESSION_SECRET: "different-worker-secret-at-least-32-characters",
    });

    expect(worker).toEqual(web);
    expect(JSON.stringify(web)).not.toContain(baseEnv.TWILIO_AUTH_TOKEN);
  });

  it("invalidates a result when the auth token, service, or callback origin changes", () => {
    const current = twilioReadinessFingerprints(baseEnv);
    expect(
      twilioReadinessFingerprints({
        ...baseEnv,
        TWILIO_AUTH_TOKEN: "rotated-high-entropy-token",
      }).configurationFingerprint,
    ).not.toBe(current.configurationFingerprint);
    expect(
      twilioReadinessFingerprints({
        ...baseEnv,
        TWILIO_MESSAGING_SERVICE_SID: `MG${"d".repeat(32)}`,
      }).serviceFingerprint,
    ).not.toBe(current.serviceFingerprint);
    expect(
      twilioReadinessFingerprints({
        ...baseEnv,
        APP_BASE_URL: "https://new.stonegate.example",
      }).configurationFingerprint,
    ).not.toBe(current.configurationFingerprint);
  });
});

describe("runTwilioReadinessDiagnostic", () => {
  it("uses only bounded read operations and persists a passing result", async () => {
    const twilioClient = passingDiagnosticClient();
    const createTwilioClient = vi.fn(() => twilioClient);
    const { store, diagnosticCreates } = storeWithRecords();

    await runTwilioReadinessDiagnostic({
      actorUserId: ADMIN_ID,
      client: store,
      env: baseEnv,
      now: NOW,
      createTwilioClient,
    });

    expect(createTwilioClient).toHaveBeenCalledWith(
      ACCOUNT_SID,
      baseEnv.TWILIO_AUTH_TOKEN,
    );
    expect(twilioClient.fetchAccount).toHaveBeenCalledOnce();
    expect(twilioClient.fetchService).toHaveBeenCalledOnce();
    expect(twilioClient.listPhoneNumbers).toHaveBeenCalledOnce();
    expect(twilioClient.listUsAppToPersonCampaigns).toHaveBeenCalledOnce();
    expect(diagnosticCreates).toHaveLength(1);
    expect(diagnosticCreates[0]).toMatchObject({
      providerKey: "twilio",
      status: "PASSED",
      checkedByUserId: ADMIN_ID,
      details: {
        accountStatus: "active",
        senderCount: 1,
        smsCapableSenderCount: 1,
        usAppToPersonRegistered: true,
        campaignStatuses: ["VERIFIED"],
      },
    });
    expect(JSON.stringify(diagnosticCreates[0])).not.toContain(
      baseEnv.TWILIO_AUTH_TOKEN,
    );
  });

  it.each([
    {
      label: "inactive account",
      overrides: {
        account: {
          sid: ACCOUNT_SID,
          status: "suspended",
          friendlyName: "Stonegate",
        },
      },
      expected: "account status is suspended",
    },
    {
      label: "wrong service SID",
      overrides: {
        service: {
          sid: `MG${"f".repeat(32)}`,
          accountSid: ACCOUNT_SID,
          friendlyName: "Wrong",
          inboundRequestUrl:
            "https://sms.stonegate.example/api/webhooks/twilio/inbound",
          inboundMethod: "POST",
          usecase: "marketing",
          usAppToPersonRegistered: true,
          useInboundWebhookOnNumber: false,
        },
      },
      expected: "Messaging Service SID did not match",
    },
    {
      label: "empty Sender Pool",
      overrides: { senders: [] },
      expected: "Sender Pool is empty",
    },
    {
      label: "non-exact inbound webhook",
      overrides: {
        service: {
          sid: SERVICE_SID,
          accountSid: ACCOUNT_SID,
          friendlyName: "Stonegate outreach",
          inboundRequestUrl:
            "https://sms.stonegate.example/api/webhooks/twilio/inbound/",
          inboundMethod: "POST",
          usecase: "marketing",
          usAppToPersonRegistered: true,
          useInboundWebhookOnNumber: false,
        },
      },
      expected: "inbound webhook does not match",
    },
  ])("fails closed for $label", async ({ overrides, expected }) => {
    const { store, diagnosticCreates } = storeWithRecords();
    await runTwilioReadinessDiagnostic({
      actorUserId: ADMIN_ID,
      client: store,
      env: baseEnv,
      now: NOW,
      createTwilioClient: () => passingDiagnosticClient(overrides),
    });

    expect(diagnosticCreates[0]).toMatchObject({ status: "FAILED" });
    expect(diagnosticCreates[0]?.summary).toContain(expected);
  });

  it("records an API failure without leaking credentials", async () => {
    const { store, diagnosticCreates } = storeWithRecords();
    const diagnosticClient = passingDiagnosticClient();
    vi.mocked(diagnosticClient.fetchAccount).mockRejectedValue(
      new Error(
        `auth_token=${baseEnv.TWILIO_AUTH_TOKEN} request failed for ${ACCOUNT_SID}`,
      ),
    );

    await runTwilioReadinessDiagnostic({
      actorUserId: ADMIN_ID,
      client: store,
      env: baseEnv,
      now: NOW,
      createTwilioClient: () => diagnosticClient,
    });

    expect(diagnosticCreates[0]).toMatchObject({ status: "FAILED" });
    expect(JSON.stringify(diagnosticCreates[0])).not.toContain(
      baseEnv.TWILIO_AUTH_TOKEN,
    );
    expect(diagnosticCreates[0]?.summary).toContain("credential=[redacted]");
  });

  it("requires an active administrator before making any provider read", async () => {
    const { store, diagnosticCreates } = storeWithRecords({
      user: { ...activeAdmin, role: "ANALYST" },
    });
    const createTwilioClient = vi.fn();

    await expect(
      runTwilioReadinessDiagnostic({
        actorUserId: ADMIN_ID,
        client: store,
        env: baseEnv,
        now: NOW,
        createTwilioClient,
      }),
    ).rejects.toThrow("active administrator");
    expect(createTwilioClient).not.toHaveBeenCalled();
    expect(diagnosticCreates).toHaveLength(0);
  });
});

describe("assertFreshTwilioReadiness", () => {
  it("passes from an injected Prisma-compatible client without provider calls", async () => {
    const records = passingRecords();
    const { store } = storeWithRecords(records);

    await expect(
      assertFreshTwilioReadiness({ client: store, env: baseEnv, now: NOW }),
    ).resolves.toMatchObject({
      ready: true,
      diagnosticReady: true,
      approvalReady: true,
    });
  });

  it("accepts the worker's different session secret for the same provider config", async () => {
    const records = passingRecords(baseEnv);
    const { store } = storeWithRecords(records);
    const workerEnv = {
      ...baseEnv,
      SESSION_SECRET: "different-worker-secret-at-least-32-characters",
    };

    await expect(
      assertFreshTwilioReadiness({ client: store, env: workerEnv, now: NOW }),
    ).resolves.toMatchObject({ ready: true });
  });

  it("blocks a stale diagnostic even if its stored expiry is later", async () => {
    const records = passingRecords();
    records.diagnostic.checkedAt = new Date(
      NOW.getTime() - 24 * 60 * 60 * 1_000 - 1,
    );
    records.diagnostic.expiresAt = new Date(NOW.getTime() + 60_000);
    records.approval.diagnosticRun.checkedAt = records.diagnostic.checkedAt;
    const { store } = storeWithRecords(records);

    await expect(
      assertFreshTwilioReadiness({ client: store, env: baseEnv, now: NOW }),
    ).rejects.toThrow("older than 24 hours");
  });

  it("blocks changed provider credentials", async () => {
    const records = passingRecords();
    const { store } = storeWithRecords(records);

    await expect(
      assertFreshTwilioReadiness({
        client: store,
        env: { ...baseEnv, TWILIO_AUTH_TOKEN: "rotated-auth-token" },
        now: NOW,
      }),
    ).rejects.toThrow("different credentials or callbacks");
  });

  it("blocks a revoked acknowledgement or an inactive approving admin", async () => {
    const revoked = passingRecords();
    revoked.approval.decision = "REVOKED";
    revoked.approval.diagnosticRun = null as never;
    const revokedStore = storeWithRecords(revoked).store;
    await expect(
      assertFreshTwilioReadiness({
        client: revokedStore,
        env: baseEnv,
        now: NOW,
      }),
    ).rejects.toThrow("approval was revoked");

    const inactive = passingRecords();
    inactive.approval.actor.active = false;
    const inactiveStore = storeWithRecords(inactive).store;
    await expect(
      assertFreshTwilioReadiness({
        client: inactiveStore,
        env: baseEnv,
        now: NOW,
      }),
    ).rejects.toThrow("no longer an active administrator");
  });

  it("reports disabled environment gates separately from the persisted checks", async () => {
    const records = passingRecords();
    const { store } = storeWithRecords(records);
    const status = await getTwilioReadinessStatus({
      client: store,
      env: {
        ...baseEnv,
        SMS_PROVIDER: "dry-run",
        SMS_LIVE_SENDS_ENABLED: false,
        TWILIO_PRODUCTION_APPROVED: false,
      },
      now: NOW,
    });

    expect(status).toMatchObject({
      ready: false,
      diagnosticReady: true,
      approvalReady: true,
      providerSelected: false,
      liveSendsEnabled: false,
      environmentProductionApproved: false,
    });
  });
});

describe("acknowledgeTwilioProductionApproval", () => {
  it("records the active admin and the passing diagnostic without needing live gates", async () => {
    const disabledEnv = {
      ...baseEnv,
      SMS_PROVIDER: "dry-run",
      SMS_LIVE_SENDS_ENABLED: false,
      TWILIO_PRODUCTION_APPROVED: false,
    };
    const records = passingRecords(disabledEnv);
    const { store, approvalCreates } = storeWithRecords({
      diagnostic: records.diagnostic,
    });

    await acknowledgeTwilioProductionApproval({
      actorUserId: ADMIN_ID,
      client: store,
      env: disabledEnv,
      now: NOW,
    });

    expect(approvalCreates).toHaveLength(1);
    expect(approvalCreates[0]).toMatchObject({
      providerKey: "twilio",
      decision: "APPROVED",
      diagnosticRunId: records.diagnostic.id,
      actorUserId: ADMIN_ID,
      occurredAt: NOW,
    });
  });

  it("refuses acknowledgement without a fresh passing diagnostic", async () => {
    const { store, approvalCreates } = storeWithRecords();
    await expect(
      acknowledgeTwilioProductionApproval({
        actorUserId: ADMIN_ID,
        client: store,
        env: baseEnv,
        now: NOW,
      }),
    ).rejects.toThrow("fresh passing diagnostic");
    expect(approvalCreates).toHaveLength(0);
  });
});
