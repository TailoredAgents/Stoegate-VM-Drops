import { createHash } from "node:crypto";

import type {
  Prisma,
  PrismaClient,
  ProviderProductionApprovalEvent,
} from "@prisma/client";
import twilio from "twilio";

import { db } from "@/lib/db";
import { getEnv, type AppEnv } from "@/lib/env";
import { lockSmsProviderReadinessTx } from "@/lib/sms-dispatch-lock";

export const TWILIO_READINESS_PROVIDER_KEY = "twilio";
export const TWILIO_READINESS_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type TwilioReadinessDatabaseClient =
  | Pick<
      PrismaClient,
      "providerDiagnosticRun" | "providerProductionApprovalEvent" | "user"
    >
  | Pick<
      Prisma.TransactionClient,
      "providerDiagnosticRun" | "providerProductionApprovalEvent" | "user"
    >;

export interface TwilioReadinessFingerprints {
  accountFingerprint: string;
  serviceFingerprint: string;
  configurationFingerprint: string;
}

export interface TwilioDiagnosticAccount {
  sid: string;
  status: string;
  friendlyName: string;
}

export interface TwilioDiagnosticService {
  sid: string;
  accountSid: string;
  friendlyName: string;
  inboundRequestUrl: string | null;
  inboundMethod: string | null;
  usecase: string;
  usAppToPersonRegistered: boolean;
  useInboundWebhookOnNumber: boolean;
}

export interface TwilioDiagnosticSender {
  sid: string;
  accountSid: string;
  serviceSid: string;
  phoneNumber: string;
  countryCode: string;
  capabilities: string[];
}

export interface TwilioDiagnosticCampaign {
  messagingServiceSid: string;
  campaignStatus: string;
  campaignId: string;
}

/** Deliberately exposes only read operations; a diagnostic client cannot send. */
export interface TwilioDiagnosticClient {
  fetchAccount(accountSid: string): Promise<TwilioDiagnosticAccount>;
  fetchService(serviceSid: string): Promise<TwilioDiagnosticService>;
  listPhoneNumbers(serviceSid: string): Promise<TwilioDiagnosticSender[]>;
  listUsAppToPersonCampaigns(
    serviceSid: string,
  ): Promise<TwilioDiagnosticCampaign[]>;
}

export type TwilioDiagnosticClientFactory = (
  accountSid: string,
  authToken: string,
) => TwilioDiagnosticClient;

export interface TwilioDiagnosticDetails {
  accountStatus?: string;
  accountFriendlyName?: string;
  serviceFriendlyName?: string;
  serviceUsecase?: string;
  senderCount?: number;
  smsCapableSenderCount?: number;
  maskedSenders?: string[];
  usAppToPersonRegistered?: boolean;
  campaignStatuses?: string[];
  inboundWebhookExpected?: string;
  inboundWebhookActual?: string | null;
  inboundMethod?: string | null;
  useInboundWebhookOnNumber?: boolean;
  failures?: string[];
}

export interface TwilioReadinessDiagnosticState {
  id: string;
  status: "PASSED" | "FAILED";
  summary: string;
  details: TwilioDiagnosticDetails;
  checkedAt: Date;
  expiresAt: Date;
  checkedByEmail: string;
  configurationMatches: boolean;
  fresh: boolean;
}

export interface TwilioReadinessApprovalState {
  decision: "APPROVED" | "REVOKED";
  occurredAt: Date;
  actorEmail: string;
  actorIsActiveAdmin: boolean;
  configurationMatches: boolean;
}

export interface TwilioReadinessStatus {
  ready: boolean;
  reason: string;
  configured: boolean;
  providerSelected: boolean;
  liveSendsEnabled: boolean;
  environmentProductionApproved: boolean;
  diagnosticReady: boolean;
  approvalReady: boolean;
  diagnostic: TwilioReadinessDiagnosticState | null;
  approval: TwilioReadinessApprovalState | null;
}

export interface TwilioReadinessOptions {
  client?: TwilioReadinessDatabaseClient;
  env?: AppEnv;
  now?: Date;
}

export interface RunTwilioReadinessDiagnosticOptions extends TwilioReadinessOptions {
  actorUserId: string;
  createTwilioClient?: TwilioDiagnosticClientFactory;
}

export interface ChangeTwilioApprovalOptions extends TwilioReadinessOptions {
  actorUserId: string;
  note?: string;
}

export class TwilioReadinessError extends Error {
  constructor(
    readonly code:
      "NOT_CONFIGURED" | "NOT_READY" | "ADMIN_REQUIRED" | "DIAGNOSTIC_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "TwilioReadinessError";
  }
}

function createDefaultDiagnosticClient(
  accountSid: string,
  authToken: string,
): TwilioDiagnosticClient {
  const client = twilio(accountSid, authToken);
  return {
    async fetchAccount(sid) {
      const account = await client.api.v2010.accounts(sid).fetch();
      return {
        sid: account.sid,
        status: account.status,
        friendlyName: account.friendlyName,
      };
    },
    async fetchService(sid) {
      const service = await client.messaging.v1.services(sid).fetch();
      return {
        sid: service.sid,
        accountSid: service.accountSid,
        friendlyName: service.friendlyName,
        inboundRequestUrl: service.inboundRequestUrl || null,
        inboundMethod: service.inboundMethod || null,
        usecase: service.usecase,
        usAppToPersonRegistered: service.usAppToPersonRegistered,
        useInboundWebhookOnNumber: service.useInboundWebhookOnNumber,
      };
    },
    async listPhoneNumbers(sid) {
      const senders = await client.messaging.v1
        .services(sid)
        .phoneNumbers.list({ limit: 100 });
      return senders.map((sender) => ({
        sid: sender.sid,
        accountSid: sender.accountSid,
        serviceSid: sender.serviceSid,
        phoneNumber: sender.phoneNumber,
        countryCode: sender.countryCode,
        capabilities: sender.capabilities,
      }));
    },
    async listUsAppToPersonCampaigns(sid) {
      const campaigns = await client.messaging.v1
        .services(sid)
        .usAppToPerson.list({ limit: 20 });
      return campaigns.map((campaign) => ({
        messagingServiceSid: campaign.messagingServiceSid,
        campaignStatus: campaign.campaignStatus,
        campaignId: campaign.campaignId,
      }));
    },
  };
}

function sha256(namespace: string, value: string): string {
  return createHash("sha256")
    .update(`stonegate-twilio-readiness:v1:${namespace}:${value}`, "utf8")
    .digest("hex");
}

function requireTwilioConfiguration(env: AppEnv) {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const serviceSid = env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!accountSid || !authToken || !serviceSid) {
    throw new TwilioReadinessError(
      "NOT_CONFIGURED",
      "Twilio account credentials and a Messaging Service SID are required",
    );
  }
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    throw new TwilioReadinessError(
      "NOT_CONFIGURED",
      "TWILIO_ACCOUNT_SID is invalid",
    );
  }
  if (!/^MG[0-9a-fA-F]{32}$/.test(serviceSid)) {
    throw new TwilioReadinessError(
      "NOT_CONFIGURED",
      "TWILIO_MESSAGING_SERVICE_SID is invalid",
    );
  }
  return { accountSid, authToken, serviceSid };
}

export function twilioReadinessFingerprints(
  env: AppEnv = getEnv(),
): TwilioReadinessFingerprints {
  const { accountSid, authToken, serviceSid } = requireTwilioConfiguration(env);
  const callbackOrigin = new URL(env.APP_BASE_URL).origin;
  const authTokenFingerprint = sha256("auth-token", authToken);
  return {
    accountFingerprint: sha256("account", accountSid),
    serviceFingerprint: sha256("service", serviceSid),
    configurationFingerprint: sha256(
      "configuration",
      JSON.stringify({
        accountSid,
        serviceSid,
        authTokenFingerprint,
        callbackOrigin,
      }),
    ),
  };
}

function safeDetails(value: Prisma.JsonValue): TwilioDiagnosticDetails {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return value as TwilioDiagnosticDetails;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : "••••";
}

function sanitizeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(AC|MG|PN|QE)[0-9a-zA-Z]{32}\b/g, (_match, prefix) => {
      return `${prefix}••••`;
    })
    .replace(
      /(?:auth[_ -]?token|password|secret)=?[^\s,;]*/gi,
      "credential=[redacted]",
    )
    .slice(0, 500);
}

async function requireActiveAdmin(
  client: TwilioReadinessDatabaseClient,
  userId: string,
) {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, active: true },
  });
  if (!user?.active || user.role !== "ADMIN") {
    throw new TwilioReadinessError(
      "ADMIN_REQUIRED",
      "An active administrator is required",
    );
  }
  return user;
}

function statusReason(
  status: Omit<TwilioReadinessStatus, "ready" | "reason">,
): string {
  if (!status.configured) return "Twilio credentials are not fully configured";
  if (!status.providerSelected) return "SMS_PROVIDER is not set to twilio";
  if (!status.environmentProductionApproved) {
    return "TWILIO_PRODUCTION_APPROVED is not enabled";
  }
  if (!status.liveSendsEnabled) return "SMS_LIVE_SENDS_ENABLED is not enabled";
  if (!status.diagnostic) return "No Twilio diagnostic has been recorded";
  if (status.diagnostic.status !== "PASSED") return status.diagnostic.summary;
  if (!status.diagnostic.configurationMatches) {
    return "The latest Twilio diagnostic was run for different credentials or callbacks";
  }
  if (!status.diagnostic.fresh) {
    return "The latest Twilio diagnostic is older than 24 hours";
  }
  if (!status.approval) {
    return "An administrator has not acknowledged Twilio production approval";
  }
  if (status.approval.decision !== "APPROVED") {
    return "Twilio production approval was revoked";
  }
  if (!status.approval.configurationMatches) {
    return "The administrator approval applies to different Twilio credentials";
  }
  if (!status.approval.actorIsActiveAdmin) {
    return "The approving administrator is no longer an active administrator";
  }
  return "Twilio is ready for controlled live SMS";
}

export async function getTwilioReadinessStatus(
  options: TwilioReadinessOptions = {},
): Promise<TwilioReadinessStatus> {
  const client = options.client ?? db;
  const env = options.env ?? getEnv();
  const now = options.now ?? new Date();

  let fingerprints: TwilioReadinessFingerprints | null = null;
  try {
    fingerprints = twilioReadinessFingerprints(env);
  } catch (error) {
    if (!(error instanceof TwilioReadinessError)) throw error;
  }

  const [diagnosticRecord, approvalRecord] = await Promise.all([
    client.providerDiagnosticRun.findFirst({
      where: { providerKey: TWILIO_READINESS_PROVIDER_KEY },
      orderBy: [{ checkedAt: "desc" }, { createdAt: "desc" }],
      include: { checkedBy: { select: { email: true } } },
    }),
    client.providerProductionApprovalEvent.findFirst({
      where: { providerKey: TWILIO_READINESS_PROVIDER_KEY },
      orderBy: { sequence: "desc" },
      include: {
        actor: { select: { email: true, active: true, role: true } },
        diagnosticRun: {
          select: {
            status: true,
            configurationFingerprint: true,
            checkedAt: true,
          },
        },
      },
    }),
  ]);

  const diagnosticConfigurationMatches = Boolean(
    fingerprints &&
    diagnosticRecord &&
    diagnosticRecord.accountFingerprint === fingerprints.accountFingerprint &&
    diagnosticRecord.serviceFingerprint === fingerprints.serviceFingerprint &&
    diagnosticRecord.configurationFingerprint ===
      fingerprints.configurationFingerprint,
  );
  const diagnosticFresh = Boolean(
    diagnosticRecord &&
    diagnosticRecord.checkedAt.getTime() <= now.getTime() &&
    diagnosticRecord.checkedAt.getTime() >=
      now.getTime() - TWILIO_READINESS_MAX_AGE_MS &&
    diagnosticRecord.expiresAt.getTime() > now.getTime(),
  );
  const diagnostic: TwilioReadinessDiagnosticState | null = diagnosticRecord
    ? {
        id: diagnosticRecord.id,
        status: diagnosticRecord.status,
        summary: diagnosticRecord.summary,
        details: safeDetails(diagnosticRecord.details),
        checkedAt: diagnosticRecord.checkedAt,
        expiresAt: diagnosticRecord.expiresAt,
        checkedByEmail: diagnosticRecord.checkedBy.email,
        configurationMatches: diagnosticConfigurationMatches,
        fresh: diagnosticFresh,
      }
    : null;

  const approvalConfigurationMatches = Boolean(
    fingerprints &&
    approvalRecord &&
    approvalRecord.configurationFingerprint ===
      fingerprints.configurationFingerprint &&
    approvalRecord.diagnosticRun?.status === "PASSED" &&
    approvalRecord.diagnosticRun.configurationFingerprint ===
      fingerprints.configurationFingerprint &&
    approvalRecord.diagnosticRun.checkedAt.getTime() <=
      approvalRecord.occurredAt.getTime(),
  );
  const approval: TwilioReadinessApprovalState | null = approvalRecord
    ? {
        decision: approvalRecord.decision,
        occurredAt: approvalRecord.occurredAt,
        actorEmail: approvalRecord.actor.email,
        actorIsActiveAdmin:
          approvalRecord.actor.active && approvalRecord.actor.role === "ADMIN",
        configurationMatches: approvalConfigurationMatches,
      }
    : null;

  const components = {
    configured: fingerprints !== null,
    providerSelected:
      env.SMS_PROVIDER.trim().toLowerCase() === TWILIO_READINESS_PROVIDER_KEY,
    liveSendsEnabled: env.SMS_LIVE_SENDS_ENABLED,
    environmentProductionApproved: env.TWILIO_PRODUCTION_APPROVED,
    diagnosticReady: Boolean(
      diagnostic &&
      diagnostic.status === "PASSED" &&
      diagnostic.configurationMatches &&
      diagnostic.fresh,
    ),
    approvalReady: Boolean(
      approval &&
      approval.decision === "APPROVED" &&
      approval.configurationMatches &&
      approval.actorIsActiveAdmin,
    ),
    diagnostic,
    approval,
  };
  const reason = statusReason(components);
  return {
    ...components,
    ready:
      components.configured &&
      components.providerSelected &&
      components.liveSendsEnabled &&
      components.environmentProductionApproved &&
      components.diagnosticReady &&
      components.approvalReady,
    reason,
  };
}

/**
 * Database-only, fail-closed live-send gate. Pass `{ client: tx }` to keep the
 * reads inside an existing Prisma transaction; this function never calls Twilio.
 */
export async function assertFreshTwilioReadiness(
  options: TwilioReadinessOptions = {},
): Promise<TwilioReadinessStatus> {
  const status = await getTwilioReadinessStatus(options);
  if (!status.ready) {
    throw new TwilioReadinessError(
      "NOT_READY",
      `Twilio live sending is blocked: ${status.reason}`,
    );
  }
  return status;
}

export async function runTwilioReadinessDiagnostic(
  options: RunTwilioReadinessDiagnosticOptions,
) {
  const client = options.client ?? db;
  const env = options.env ?? getEnv();
  const now = options.now ?? new Date();
  const admin = await requireActiveAdmin(client, options.actorUserId);
  const { accountSid, authToken, serviceSid } = requireTwilioConfiguration(env);
  const fingerprints = twilioReadinessFingerprints(env);
  const expectedInboundWebhook = new URL(
    "/api/webhooks/twilio/inbound",
    env.APP_BASE_URL,
  ).toString();
  const details: TwilioDiagnosticDetails = {
    inboundWebhookExpected: expectedInboundWebhook,
  };
  const failures: string[] = [];

  try {
    if (new URL(env.APP_BASE_URL).protocol !== "https:") {
      failures.push("APP_BASE_URL must use HTTPS");
    }
    const diagnosticClient = (
      options.createTwilioClient ?? createDefaultDiagnosticClient
    )(accountSid, authToken);
    const [account, service, senders, campaigns] = await Promise.all([
      diagnosticClient.fetchAccount(accountSid),
      diagnosticClient.fetchService(serviceSid),
      diagnosticClient.listPhoneNumbers(serviceSid),
      diagnosticClient.listUsAppToPersonCampaigns(serviceSid),
    ]);

    details.accountStatus = account.status;
    details.accountFriendlyName = account.friendlyName;
    details.serviceFriendlyName = service.friendlyName;
    details.serviceUsecase = service.usecase;
    details.senderCount = senders.length;
    details.smsCapableSenderCount = senders.filter((sender) =>
      sender.capabilities.some(
        (capability) => capability.toUpperCase() === "SMS",
      ),
    ).length;
    details.maskedSenders = senders.map((sender) =>
      maskPhone(sender.phoneNumber),
    );
    details.usAppToPersonRegistered = service.usAppToPersonRegistered;
    details.campaignStatuses = campaigns.map((campaign) =>
      campaign.campaignStatus.toUpperCase(),
    );
    details.inboundWebhookActual = service.inboundRequestUrl;
    details.inboundMethod = service.inboundMethod;
    details.useInboundWebhookOnNumber = service.useInboundWebhookOnNumber;

    if (account.sid !== accountSid) failures.push("Account SID did not match");
    if (account.status.toLowerCase() !== "active") {
      failures.push(`Twilio account status is ${account.status}`);
    }
    if (service.sid !== serviceSid) {
      failures.push("Messaging Service SID did not match");
    }
    if (service.accountSid !== accountSid) {
      failures.push("Messaging Service belongs to a different account");
    }
    if (senders.length === 0) {
      failures.push("Messaging Service Sender Pool is empty");
    } else if ((details.smsCapableSenderCount ?? 0) === 0) {
      failures.push("Sender Pool has no SMS-capable phone number");
    }
    if (
      senders.some(
        (sender) =>
          sender.accountSid !== accountSid || sender.serviceSid !== serviceSid,
      )
    ) {
      failures.push(
        "Sender Pool returned a sender for another account/service",
      );
    }
    if (!service.usAppToPersonRegistered) {
      failures.push("Messaging Service is not registered for US A2P 10DLC");
    }
    if (
      !campaigns.some(
        (campaign) =>
          campaign.messagingServiceSid === serviceSid &&
          campaign.campaignStatus.toUpperCase() === "VERIFIED",
      )
    ) {
      failures.push("No VERIFIED A2P campaign is attached to the service");
    }
    if (service.useInboundWebhookOnNumber) {
      failures.push(
        "Per-number inbound webhooks override the Messaging Service",
      );
    }
    if (service.inboundRequestUrl !== expectedInboundWebhook) {
      failures.push(
        "Messaging Service inbound webhook does not match APP_BASE_URL",
      );
    }
    if (service.inboundMethod?.toUpperCase() !== "POST") {
      failures.push("Messaging Service inbound webhook method is not POST");
    }
  } catch (error) {
    failures.push(`Twilio read failed: ${sanitizeFailure(error)}`);
  }

  details.failures = failures;
  const passed = failures.length === 0;
  const summary = passed
    ? "Twilio account, Messaging Service, verified A2P campaign, Sender Pool, and inbound webhook passed."
    : `Twilio diagnostic failed: ${failures.join("; ")}`.slice(0, 1_000);

  const data = {
    providerKey: TWILIO_READINESS_PROVIDER_KEY,
    status: passed ? ("PASSED" as const) : ("FAILED" as const),
    ...fingerprints,
    summary,
    details: details as Prisma.InputJsonValue,
    checkedAt: now,
    expiresAt: new Date(now.getTime() + TWILIO_READINESS_MAX_AGE_MS),
    checkedByUserId: admin.id,
  };
  if (options.client)
    return options.client.providerDiagnosticRun.create({ data });
  return db.$transaction(
    async (tx) => {
      await lockSmsProviderReadinessTx(tx, TWILIO_READINESS_PROVIDER_KEY);
      await requireActiveAdmin(tx, options.actorUserId);
      return tx.providerDiagnosticRun.create({ data });
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

export async function acknowledgeTwilioProductionApproval(
  options: ChangeTwilioApprovalOptions,
): Promise<ProviderProductionApprovalEvent> {
  if (!options.client)
    return db.$transaction(
      async (tx) => {
        await lockSmsProviderReadinessTx(tx, TWILIO_READINESS_PROVIDER_KEY);
        return acknowledgeTwilioProductionApproval({
          ...options,
          client: tx,
        });
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  const client = options.client ?? db;
  const env = options.env ?? getEnv();
  const now = options.now ?? new Date();
  const admin = await requireActiveAdmin(client, options.actorUserId);
  const status = await getTwilioReadinessStatus({ client, env, now });
  if (!status.diagnosticReady || !status.diagnostic) {
    throw new TwilioReadinessError(
      "DIAGNOSTIC_REQUIRED",
      "A fresh passing diagnostic for the current Twilio configuration is required before approval",
    );
  }
  const fingerprints = twilioReadinessFingerprints(env);
  return client.providerProductionApprovalEvent.create({
    data: {
      providerKey: TWILIO_READINESS_PROVIDER_KEY,
      decision: "APPROVED",
      configurationFingerprint: fingerprints.configurationFingerprint,
      diagnosticRunId: status.diagnostic.id,
      actorUserId: admin.id,
      note:
        options.note?.trim() ||
        "Administrator acknowledged external Twilio production approval.",
      occurredAt: now,
    },
  });
}

export async function revokeTwilioProductionApproval(
  options: ChangeTwilioApprovalOptions,
): Promise<ProviderProductionApprovalEvent> {
  if (!options.client)
    return db.$transaction(
      async (tx) => {
        await lockSmsProviderReadinessTx(tx, TWILIO_READINESS_PROVIDER_KEY);
        return revokeTwilioProductionApproval({ ...options, client: tx });
      },
      { maxWait: 10_000, timeout: 60_000 },
    );
  const client = options.client ?? db;
  const env = options.env ?? getEnv();
  const now = options.now ?? new Date();
  const admin = await requireActiveAdmin(client, options.actorUserId);
  let configurationFingerprint: string;
  try {
    configurationFingerprint =
      twilioReadinessFingerprints(env).configurationFingerprint;
  } catch (error) {
    if (!(error instanceof TwilioReadinessError)) throw error;
    configurationFingerprint = sha256("configuration", "unconfigured");
  }
  return client.providerProductionApprovalEvent.create({
    data: {
      providerKey: TWILIO_READINESS_PROVIDER_KEY,
      decision: "REVOKED",
      configurationFingerprint,
      actorUserId: admin.id,
      note:
        options.note?.trim() ||
        "Administrator revoked Twilio production approval.",
      occurredAt: now,
    },
  });
}
