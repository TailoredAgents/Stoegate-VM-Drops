-- Stonegate SMS Outreach domain layer.
-- This migration is intentionally forward-only: every legacy RVM table, enum,
-- column, and row is retained for historical auditability.

-- CreateEnum
CREATE TYPE "CampaignKind" AS ENUM ('LEGACY_RVM', 'SMS');

-- CreateEnum
CREATE TYPE "SmsTemplateStatus" AS ENUM ('DRAFT', 'APPROVED', 'RETIRED');

-- CreateEnum
CREATE TYPE "SmsComplianceStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SmsMessageStatus" AS ENUM ('PENDING', 'SCHEDULED', 'DRY_RUN', 'QUEUED', 'SUBMITTING', 'SUBMISSION_UNKNOWN', 'ACCEPTED', 'SENT', 'DELIVERED', 'UNDELIVERED', 'FAILED', 'REPLIED', 'SUPPRESSED', 'CANCELED');

-- CreateEnum
CREATE TYPE "SmsAttemptStatus" AS ENUM ('STARTED', 'ACCEPTED', 'FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SmsConversationStatus" AS ENUM ('OPEN', 'CLOSED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "SmsInboundClassification" AS ENUM ('UNCLASSIFIED', 'INTERESTED', 'MAYBE', 'QUALIFIED_LEAD', 'FOLLOW_UP', 'NOT_INTERESTED', 'PROPERTY_SOLD', 'AGENT', 'HOSTILE', 'WRONG_NUMBER', 'OPT_OUT', 'OTHER', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "SmsConsentStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SmsConsentBasis" AS ENUM ('UNKNOWN', 'EXPRESS_WRITTEN', 'EXPRESS', 'PRIOR_BUSINESS_RELATIONSHIP', 'OTHER');

-- CreateEnum
CREATE TYPE "SmsUsageKind" AS ENUM ('ATTEMPT', 'ACCEPTED', 'DELIVERED');

-- Extend existing lifecycle enums without removing or renaming legacy values.
ALTER TYPE "CampaignStatus" ADD VALUE 'SCHEDULED';

ALTER TYPE "CampaignContactStatus" ADD VALUE 'PREVIEW_READY';
ALTER TYPE "CampaignContactStatus" ADD VALUE 'DRY_RUN';
ALTER TYPE "CampaignContactStatus" ADD VALUE 'ACCEPTED';
ALTER TYPE "CampaignContactStatus" ADD VALUE 'SENT';
ALTER TYPE "CampaignContactStatus" ADD VALUE 'UNDELIVERED';
ALTER TYPE "CampaignContactStatus" ADD VALUE 'SUPPRESSED';

ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_PENDING';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_SCHEDULED';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_DRY_RUN';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_QUEUED';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_SENDING';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_SUBMISSION_UNKNOWN';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_ACCEPTED';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_SENT';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_DELIVERED';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_UNDELIVERED';
ALTER TYPE "OutreachSequenceState" ADD VALUE 'SMS_SUPPRESSED';

ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_PENDING';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_SCHEDULED';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_DRY_RUN';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_QUEUED';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_SUBMISSION_STARTED';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_SUBMISSION_UNKNOWN';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_ACCEPTED';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_SENT';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_DELIVERED';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_UNDELIVERED';
ALTER TYPE "OutreachEventType" ADD VALUE 'SMS_SUPPRESSED';

-- Existing campaigns are RVM history. Add the discriminator without a default,
-- backfill those rows explicitly, and only then make future campaigns SMS-first.
ALTER TABLE "Campaign" ADD COLUMN "kind" "CampaignKind";
UPDATE "Campaign" SET "kind" = 'LEGACY_RVM' WHERE "kind" IS NULL;
ALTER TABLE "Campaign" ALTER COLUMN "kind" SET NOT NULL;
ALTER TABLE "Campaign" ALTER COLUMN "kind" SET DEFAULT 'SMS';

-- AlterTable
ALTER TABLE "Campaign"
ADD COLUMN "approvedByUserId" UUID,
ADD COLUMN "createdByUserId" UUID,
ADD COLUMN "pausedAt" TIMESTAMP(3),
ADD COLUMN "sourceName" TEXT,
ADD COLUMN "smsColdCallDelayHours" INTEGER NOT NULL DEFAULT 48,
ADD COLUMN "smsComplianceNotes" TEXT,
ADD COLUMN "smsComplianceStatus" "SmsComplianceStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN "smsCostConfig" JSONB,
ADD COLUMN "smsCurrency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN "smsDailyCap" INTEGER NOT NULL DEFAULT 2000,
ADD COLUMN "smsEstimatedCostPerSegmentMicros" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "smsProviderConfig" JSONB,
ADD COLUMN "smsProviderKey" TEXT,
ADD COLUMN "smsScheduleTimezone" TEXT NOT NULL DEFAULT 'America/New_York',
ADD COLUMN "smsScheduledFor" TIMESTAMP(3),
ADD COLUMN "smsSendWindowEndMinutes" INTEGER,
ADD COLUMN "smsSendWindowStartMinutes" INTEGER,
ADD COLUMN "smsSenderRef" TEXT,
ADD COLUMN "smsTemplateVersionId" UUID;

-- Existing sequence states remain unchanged; this only makes newly-created
-- sequences safe and SMS-first. No historical timestamps are inferred.
ALTER TABLE "OutreachSequence"
ADD COLUMN "coldCallDueAt" TIMESTAMP(3),
ADD COLUMN "smsScheduledFor" TIMESTAMP(3),
ADD COLUMN "smsToColdCallDelayHours" INTEGER NOT NULL DEFAULT 48;

-- Preserve existing global suppressions and backfill the new audit timestamp.
ALTER TABLE "SuppressionEntry"
ADD COLUMN "createdByUserId" UUID,
ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "SuppressionEntry" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;
ALTER TABLE "SuppressionEntry" ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateTable
CREATE TABLE "SmsTemplate" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsTemplateVersion" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "SmsTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" UUID NOT NULL,
    "approvedByUserId" UUID,
    "approvedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConversation" (
    "id" UUID NOT NULL,
    "campaignContactId" UUID NOT NULL,
    "providerKey" TEXT,
    "providerConversationId" TEXT,
    "status" "SmsConversationStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsOutboundMessage" (
    "id" UUID NOT NULL,
    "campaignContactId" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "conversationId" UUID,
    "templateVersionId" UUID NOT NULL,
    "consentEvidenceId" UUID,
    "sequenceNumber" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "fromPhone" TEXT,
    "renderedBody" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "segmentCount" INTEGER NOT NULL DEFAULT 1,
    "actualSegmentCount" INTEGER,
    "providerKey" TEXT,
    "providerMessageId" TEXT,
    "providerStatus" TEXT,
    "status" "SmsMessageStatus" NOT NULL DEFAULT 'PENDING',
    "estimatedCostMicros" INTEGER NOT NULL DEFAULT 0,
    "actualCostMicros" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "complianceSnapshot" JSONB,
    "suppressionCheckedAt" TIMESTAMP(3),
    "scheduledFor" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "submissionStartedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsOutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsOutboundAttempt" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "providerMessageId" TEXT,
    "status" "SmsAttemptStatus" NOT NULL DEFAULT 'STARTED',
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsOutboundAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsStatusEvent" (
    "id" UUID NOT NULL,
    "messageId" UUID,
    "providerKey" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" "SmsMessageStatus",
    "providerStatus" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,

    CONSTRAINT "SmsStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsInboundMessage" (
    "id" UUID NOT NULL,
    "conversationId" UUID,
    "contactId" UUID,
    "campaignContactId" UUID,
    "inReplyToMessageId" UUID,
    "providerKey" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "fromPhone" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "classification" "SmsInboundClassification" NOT NULL DEFAULT 'UNCLASSIFIED',
    "classificationSource" TEXT,
    "classificationConfidence" DECIMAL(5,4),
    "classifiedAt" TIMESTAMP(3),
    "classifiedByUserId" UUID,
    "isOptOut" BOOLEAN NOT NULL DEFAULT false,
    "rawPayload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsInboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignSuppression" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "contactId" UUID,
    "normalizedPhone" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "source" TEXT,
    "notes" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsConsentEvidence" (
    "id" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "campaignId" UUID,
    "campaignContactId" UUID,
    "normalizedPhone" TEXT NOT NULL,
    "status" "SmsConsentStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "basis" "SmsConsentBasis" NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT NOT NULL,
    "disclosureText" TEXT,
    "evidence" JSONB NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsConsentEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsAuditEvent" (
    "id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "campaignId" UUID,
    "campaignContactId" UUID,
    "actorUserId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsDailyUsage" (
    "id" UUID NOT NULL,
    "localDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "cap" INTEGER NOT NULL,
    "attemptedCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsDailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsUsageLedger" (
    "id" UUID NOT NULL,
    "dailyUsageId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "kind" "SmsUsageKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsUsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SmsTemplate_name_key" ON "SmsTemplate"("name");
CREATE INDEX "SmsTemplate_active_updatedAt_idx" ON "SmsTemplate"("active", "updatedAt");
CREATE INDEX "SmsTemplate_createdByUserId_idx" ON "SmsTemplate"("createdByUserId");

CREATE INDEX "SmsTemplateVersion_templateId_status_idx" ON "SmsTemplateVersion"("templateId", "status");
CREATE INDEX "SmsTemplateVersion_contentHash_idx" ON "SmsTemplateVersion"("contentHash");
CREATE INDEX "SmsTemplateVersion_createdByUserId_idx" ON "SmsTemplateVersion"("createdByUserId");
CREATE INDEX "SmsTemplateVersion_approvedByUserId_idx" ON "SmsTemplateVersion"("approvedByUserId");
CREATE UNIQUE INDEX "SmsTemplateVersion_templateId_version_key" ON "SmsTemplateVersion"("templateId", "version");

CREATE UNIQUE INDEX "SmsConversation_campaignContactId_key" ON "SmsConversation"("campaignContactId");
CREATE INDEX "SmsConversation_status_lastMessageAt_idx" ON "SmsConversation"("status", "lastMessageAt");
CREATE UNIQUE INDEX "SmsConversation_providerKey_providerConversationId_key" ON "SmsConversation"("providerKey", "providerConversationId");

CREATE UNIQUE INDEX "SmsOutboundMessage_idempotencyKey_key" ON "SmsOutboundMessage"("idempotencyKey");
CREATE INDEX "SmsOutboundMessage_status_scheduledFor_idx" ON "SmsOutboundMessage"("status", "scheduledFor");
CREATE INDEX "SmsOutboundMessage_sequenceId_status_idx" ON "SmsOutboundMessage"("sequenceId", "status");
CREATE INDEX "SmsOutboundMessage_campaignContactId_status_idx" ON "SmsOutboundMessage"("campaignContactId", "status");
CREATE INDEX "SmsOutboundMessage_conversationId_createdAt_idx" ON "SmsOutboundMessage"("conversationId", "createdAt");
CREATE INDEX "SmsOutboundMessage_templateVersionId_idx" ON "SmsOutboundMessage"("templateVersionId");
CREATE INDEX "SmsOutboundMessage_consentEvidenceId_idx" ON "SmsOutboundMessage"("consentEvidenceId");
CREATE UNIQUE INDEX "SmsOutboundMessage_campaignContactId_sequenceNumber_key" ON "SmsOutboundMessage"("campaignContactId", "sequenceNumber");
CREATE UNIQUE INDEX "SmsOutboundMessage_providerKey_providerMessageId_key" ON "SmsOutboundMessage"("providerKey", "providerMessageId");

CREATE UNIQUE INDEX "SmsOutboundAttempt_idempotencyKey_key" ON "SmsOutboundAttempt"("idempotencyKey");
CREATE INDEX "SmsOutboundAttempt_messageId_status_idx" ON "SmsOutboundAttempt"("messageId", "status");
CREATE UNIQUE INDEX "SmsOutboundAttempt_providerKey_providerMessageId_key" ON "SmsOutboundAttempt"("providerKey", "providerMessageId");
CREATE UNIQUE INDEX "SmsOutboundAttempt_providerKey_providerRequestId_key" ON "SmsOutboundAttempt"("providerKey", "providerRequestId");
CREATE UNIQUE INDEX "SmsOutboundAttempt_messageId_attemptNumber_key" ON "SmsOutboundAttempt"("messageId", "attemptNumber");

CREATE INDEX "SmsStatusEvent_messageId_occurredAt_idx" ON "SmsStatusEvent"("messageId", "occurredAt");
CREATE INDEX "SmsStatusEvent_providerKey_providerMessageId_idx" ON "SmsStatusEvent"("providerKey", "providerMessageId");
CREATE INDEX "SmsStatusEvent_status_receivedAt_idx" ON "SmsStatusEvent"("status", "receivedAt");
CREATE UNIQUE INDEX "SmsStatusEvent_providerKey_providerEventId_key" ON "SmsStatusEvent"("providerKey", "providerEventId");

CREATE INDEX "SmsInboundMessage_conversationId_receivedAt_idx" ON "SmsInboundMessage"("conversationId", "receivedAt");
CREATE INDEX "SmsInboundMessage_contactId_receivedAt_idx" ON "SmsInboundMessage"("contactId", "receivedAt");
CREATE INDEX "SmsInboundMessage_campaignContactId_receivedAt_idx" ON "SmsInboundMessage"("campaignContactId", "receivedAt");
CREATE INDEX "SmsInboundMessage_fromPhone_receivedAt_idx" ON "SmsInboundMessage"("fromPhone", "receivedAt");
CREATE INDEX "SmsInboundMessage_toPhone_receivedAt_idx" ON "SmsInboundMessage"("toPhone", "receivedAt");
CREATE INDEX "SmsInboundMessage_classification_receivedAt_idx" ON "SmsInboundMessage"("classification", "receivedAt");
CREATE INDEX "SmsInboundMessage_inReplyToMessageId_idx" ON "SmsInboundMessage"("inReplyToMessageId");
CREATE INDEX "SmsInboundMessage_classifiedByUserId_idx" ON "SmsInboundMessage"("classifiedByUserId");
CREATE UNIQUE INDEX "SmsInboundMessage_providerKey_providerMessageId_key" ON "SmsInboundMessage"("providerKey", "providerMessageId");

CREATE INDEX "CampaignSuppression_campaignId_reason_createdAt_idx" ON "CampaignSuppression"("campaignId", "reason", "createdAt");
CREATE INDEX "CampaignSuppression_contactId_idx" ON "CampaignSuppression"("contactId");
CREATE INDEX "CampaignSuppression_createdByUserId_idx" ON "CampaignSuppression"("createdByUserId");
CREATE UNIQUE INDEX "CampaignSuppression_campaignId_normalizedPhone_key" ON "CampaignSuppression"("campaignId", "normalizedPhone");

CREATE INDEX "SmsConsentEvidence_normalizedPhone_status_capturedAt_idx" ON "SmsConsentEvidence"("normalizedPhone", "status", "capturedAt");
CREATE INDEX "SmsConsentEvidence_contactId_capturedAt_idx" ON "SmsConsentEvidence"("contactId", "capturedAt");
CREATE INDEX "SmsConsentEvidence_campaignId_status_idx" ON "SmsConsentEvidence"("campaignId", "status");
CREATE INDEX "SmsConsentEvidence_campaignContactId_idx" ON "SmsConsentEvidence"("campaignContactId");
CREATE INDEX "SmsConsentEvidence_createdByUserId_idx" ON "SmsConsentEvidence"("createdByUserId");
CREATE INDEX "SmsConsentEvidence_status_expiresAt_idx" ON "SmsConsentEvidence"("status", "expiresAt");

CREATE UNIQUE INDEX "SmsAuditEvent_idempotencyKey_key" ON "SmsAuditEvent"("idempotencyKey");
CREATE INDEX "SmsAuditEvent_entityType_entityId_occurredAt_idx" ON "SmsAuditEvent"("entityType", "entityId", "occurredAt");
CREATE INDEX "SmsAuditEvent_eventType_occurredAt_idx" ON "SmsAuditEvent"("eventType", "occurredAt");
CREATE INDEX "SmsAuditEvent_campaignId_occurredAt_idx" ON "SmsAuditEvent"("campaignId", "occurredAt");
CREATE INDEX "SmsAuditEvent_campaignContactId_occurredAt_idx" ON "SmsAuditEvent"("campaignContactId", "occurredAt");
CREATE INDEX "SmsAuditEvent_actorUserId_occurredAt_idx" ON "SmsAuditEvent"("actorUserId", "occurredAt");

CREATE INDEX "SmsDailyUsage_timezone_localDate_idx" ON "SmsDailyUsage"("timezone", "localDate");
CREATE UNIQUE INDEX "SmsDailyUsage_localDate_timezone_key" ON "SmsDailyUsage"("localDate", "timezone");

CREATE INDEX "SmsUsageLedger_dailyUsageId_kind_idx" ON "SmsUsageLedger"("dailyUsageId", "kind");
CREATE INDEX "SmsUsageLedger_kind_occurredAt_idx" ON "SmsUsageLedger"("kind", "occurredAt");
CREATE UNIQUE INDEX "SmsUsageLedger_messageId_kind_key" ON "SmsUsageLedger"("messageId", "kind");

CREATE INDEX "Campaign_kind_status_smsScheduledFor_idx" ON "Campaign"("kind", "status", "smsScheduledFor");
CREATE INDEX "Campaign_kind_sourceName_status_idx" ON "Campaign"("kind", "sourceName", "status");
CREATE INDEX "Campaign_createdByUserId_idx" ON "Campaign"("createdByUserId");
CREATE INDEX "Campaign_approvedByUserId_idx" ON "Campaign"("approvedByUserId");
CREATE INDEX "Campaign_smsTemplateVersionId_idx" ON "Campaign"("smsTemplateVersionId");
CREATE INDEX "Campaign_smsProviderKey_status_idx" ON "Campaign"("smsProviderKey", "status");

CREATE INDEX "OutreachSequence_currentState_smsScheduledFor_idx" ON "OutreachSequence"("currentState", "smsScheduledFor");
CREATE INDEX "OutreachSequence_currentState_coldCallDueAt_idx" ON "OutreachSequence"("currentState", "coldCallDueAt");
CREATE INDEX "SuppressionEntry_createdByUserId_idx" ON "SuppressionEntry"("createdByUserId");

-- Database-level guardrails for values used by concurrent workers and billing.
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_smsDailyCap_check" CHECK ("smsDailyCap" > 0);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_smsColdCallDelayHours_check" CHECK ("smsColdCallDelayHours" >= 0);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_smsEstimatedCostPerSegmentMicros_check" CHECK ("smsEstimatedCostPerSegmentMicros" >= 0);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_smsSendWindowStartMinutes_check" CHECK ("smsSendWindowStartMinutes" IS NULL OR "smsSendWindowStartMinutes" BETWEEN 0 AND 1439);
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_smsSendWindowEndMinutes_check" CHECK ("smsSendWindowEndMinutes" IS NULL OR "smsSendWindowEndMinutes" BETWEEN 0 AND 1439);

ALTER TABLE "SmsTemplateVersion" ADD CONSTRAINT "SmsTemplateVersion_version_check" CHECK ("version" > 0);
ALTER TABLE "SmsTemplateVersion" ADD CONSTRAINT "SmsTemplateVersion_approval_check" CHECK ("status" <> 'APPROVED' OR ("approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL));

ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_sequenceNumber_check" CHECK ("sequenceNumber" > 0);
ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_segmentCount_check" CHECK ("segmentCount" > 0);
ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_actualSegmentCount_check" CHECK ("actualSegmentCount" IS NULL OR "actualSegmentCount" > 0);
ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_estimatedCostMicros_check" CHECK ("estimatedCostMicros" >= 0);
ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_actualCostMicros_check" CHECK ("actualCostMicros" IS NULL OR "actualCostMicros" >= 0);

ALTER TABLE "SmsOutboundAttempt" ADD CONSTRAINT "SmsOutboundAttempt_attemptNumber_check" CHECK ("attemptNumber" > 0);
ALTER TABLE "SmsInboundMessage" ADD CONSTRAINT "SmsInboundMessage_classificationConfidence_check" CHECK ("classificationConfidence" IS NULL OR ("classificationConfidence" >= 0 AND "classificationConfidence" <= 1));
ALTER TABLE "SmsConsentEvidence" ADD CONSTRAINT "SmsConsentEvidence_expiresAt_check" CHECK ("expiresAt" IS NULL OR "expiresAt" >= "capturedAt");
ALTER TABLE "SmsConsentEvidence" ADD CONSTRAINT "SmsConsentEvidence_revokedAt_check" CHECK ("revokedAt" IS NULL OR "revokedAt" >= "capturedAt");
ALTER TABLE "SmsDailyUsage" ADD CONSTRAINT "SmsDailyUsage_cap_check" CHECK ("cap" > 0);
ALTER TABLE "SmsDailyUsage" ADD CONSTRAINT "SmsDailyUsage_counts_check" CHECK ("attemptedCount" >= 0 AND "acceptedCount" >= 0 AND "deliveredCount" >= 0);

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_smsTemplateVersionId_fkey" FOREIGN KEY ("smsTemplateVersionId") REFERENCES "SmsTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsTemplate" ADD CONSTRAINT "SmsTemplate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SmsTemplateVersion" ADD CONSTRAINT "SmsTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "SmsTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsTemplateVersion" ADD CONSTRAINT "SmsTemplateVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SmsTemplateVersion" ADD CONSTRAINT "SmsTemplateVersion_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsConversation" ADD CONSTRAINT "SmsConversation_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "OutreachSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SmsConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "SmsTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SmsOutboundMessage" ADD CONSTRAINT "SmsOutboundMessage_consentEvidenceId_fkey" FOREIGN KEY ("consentEvidenceId") REFERENCES "SmsConsentEvidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsOutboundAttempt" ADD CONSTRAINT "SmsOutboundAttempt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SmsOutboundMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsStatusEvent" ADD CONSTRAINT "SmsStatusEvent_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SmsOutboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsInboundMessage" ADD CONSTRAINT "SmsInboundMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SmsConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsInboundMessage" ADD CONSTRAINT "SmsInboundMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsInboundMessage" ADD CONSTRAINT "SmsInboundMessage_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsInboundMessage" ADD CONSTRAINT "SmsInboundMessage_inReplyToMessageId_fkey" FOREIGN KEY ("inReplyToMessageId") REFERENCES "SmsOutboundMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsInboundMessage" ADD CONSTRAINT "SmsInboundMessage_classifiedByUserId_fkey" FOREIGN KEY ("classifiedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CampaignSuppression" ADD CONSTRAINT "CampaignSuppression_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignSuppression" ADD CONSTRAINT "CampaignSuppression_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CampaignSuppression" ADD CONSTRAINT "CampaignSuppression_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsConsentEvidence" ADD CONSTRAINT "SmsConsentEvidence_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsConsentEvidence" ADD CONSTRAINT "SmsConsentEvidence_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsConsentEvidence" ADD CONSTRAINT "SmsConsentEvidence_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsConsentEvidence" ADD CONSTRAINT "SmsConsentEvidence_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsAuditEvent" ADD CONSTRAINT "SmsAuditEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsAuditEvent" ADD CONSTRAINT "SmsAuditEvent_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SmsAuditEvent" ADD CONSTRAINT "SmsAuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SmsUsageLedger" ADD CONSTRAINT "SmsUsageLedger_dailyUsageId_fkey" FOREIGN KEY ("dailyUsageId") REFERENCES "SmsDailyUsage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmsUsageLedger" ADD CONSTRAINT "SmsUsageLedger_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SmsOutboundMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed every active SMS setting without overwriting operator-edited values.
-- Legacy RVM setting rows remain untouched for historical reports.
INSERT INTO "AppSetting" ("id", "key", "value", "description", "updatedAt") VALUES
  (gen_random_uuid(), 'sms_provider_fixed_monthly_fee_cents', '0'::jsonb, 'Editable SMS provider fixed monthly fee in cents', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_cost_per_outbound_message_micros', '0'::jsonb, 'Editable estimated provider cost per outbound SMS in USD micros', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_cost_per_segment_micros', '0'::jsonb, 'Editable estimated provider cost per SMS segment in USD micros', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_cost_per_inbound_message_micros', '0'::jsonb, 'Editable estimated provider cost per inbound SMS in USD micros', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_phone_number_monthly_cents', '0'::jsonb, 'Editable monthly SMS phone-number cost in cents', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_registration_monthly_cents', '0'::jsonb, 'Editable monthly SMS registration or compliance cost in cents', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_to_cold_call_delay_hours', '48'::jsonb, 'Elapsed hours after an SMS send before cold-call eligibility', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'daily_sms_cap', '2000'::jsonb, 'Global local-day SMS attempt safety cap', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'provider_billing_cycle_day', '1'::jsonb, 'Provider billing-cycle start day, from 1 through 28', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'infrastructure_monthly_overhead_cents', '0'::jsonb, 'Optional monthly infrastructure overhead', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'va_hourly_rate_cents', '700'::jsonb, 'VA hourly labor rate', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'va_real_conversations_per_hour', '6'::jsonb, 'Real conversations completed per VA hour', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'va_real_conversations_per_lead', '40'::jsonb, 'Real conversations required per qualified lead', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'va_leads_per_deal', '15'::jsonb, 'Qualified leads required per deal', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'operations_timezone', '"America/New_York"'::jsonb, 'IANA timezone for operating days and send windows', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_send_window_start', '"09:00"'::jsonb, 'Default local SMS send-window start in HH:MM', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_send_window_end', '"20:00"'::jsonb, 'Default local SMS send-window end in HH:MM', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_provider_display_name', '"Not selected"'::jsonb, 'Operator-facing SMS provider label', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_sender_identification', '""'::jsonb, 'Approved sender identification appended or represented in outbound SMS copy', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_compliance_notes', '""'::jsonb, 'Operator-maintained SMS compliance notes and assumptions', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
