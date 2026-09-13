-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ANALYST');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'DATA_READY', 'PREVIEW_GENERATING', 'PREVIEW_READY', 'APPROVED', 'QUEUED', 'SENDING', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('STAGING', 'ANALYZED', 'COMMITTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('ELIGIBLE', 'INVALID_PHONE', 'DUPLICATE_PHONE', 'DUPLICATE_PHONE_PROPERTY', 'SUPPRESSED', 'MISSING_REQUIRED');

-- CreateEnum
CREATE TYPE "CampaignContactStatus" AS ENUM ('ELIGIBLE', 'AUDIO_PENDING', 'AUDIO_READY', 'QUEUED', 'SENDING', 'DELIVERED', 'FAILED', 'OPTED_OUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AudioStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "DropStatus" AS ENUM ('PENDING', 'DRY_RUN', 'QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'OPTED_OUT', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CallbackOutcomeType" AS ENUM ('CALLBACK', 'INTERESTED', 'QUALIFIED_LEAD', 'NOT_INTERESTED', 'WRONG_NUMBER', 'OPT_OUT', 'FOLLOW_UP', 'CONTRACT', 'CLOSED');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('OPT_OUT', 'MANUAL', 'WRONG_NUMBER', 'PROVIDER_DNC', 'COMPLIANCE');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "sendLimit" INTEGER NOT NULL DEFAULT 1000,
    "uploadedCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "scriptTemplateVersionId" UUID,
    "voiceConfigurationId" UUID,
    "approvedAt" TIMESTAMP(3),
    "launchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" UUID NOT NULL,
    "normalizedPhone" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "ownerName" TEXT,
    "source" TEXT,
    "externalId" TEXT,
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Property" (
    "id" UUID NOT NULL,
    "propertyAddress" TEXT,
    "streetName" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "county" TEXT,
    "acreage" DECIMAL(12,3),
    "propertyType" TEXT,
    "externalId" TEXT,
    "source" TEXT,
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Property_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactProperty" (
    "id" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "propertyId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignContact" (
    "id" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "propertyId" UUID,
    "importRowId" UUID,
    "status" "CampaignContactStatus" NOT NULL DEFAULT 'ELIGIBLE',
    "isPreview" BOOLEAN NOT NULL DEFAULT false,
    "selectedForSend" BOOLEAN NOT NULL DEFAULT false,
    "renderedText" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptTemplate" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScriptTemplateVersion" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceConfiguration" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "settings" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioAsset" (
    "id" UUID NOT NULL,
    "campaignContactId" UUID NOT NULL,
    "scriptTemplateVersionId" UUID NOT NULL,
    "voiceConfigurationId" UUID NOT NULL,
    "renderedText" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "voiceId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "characterCount" INTEGER NOT NULL,
    "providerGenerationId" TEXT,
    "objectKey" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "durationSeconds" DOUBLE PRECISION,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "status" "AudioStatus" NOT NULL DEFAULT 'PENDING',
    "generatedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Drop" (
    "id" UUID NOT NULL,
    "campaignContactId" UUID NOT NULL,
    "audioAssetId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'dropcowboy',
    "providerMessageId" TEXT,
    "status" "DropStatus" NOT NULL DEFAULT 'PENDING',
    "providerResponse" JSONB,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "optedOutAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Drop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryEvent" (
    "id" UUID NOT NULL,
    "dropId" UUID NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallbackOutcome" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "campaignId" UUID,
    "campaignContactId" UUID,
    "normalizedPhone" TEXT NOT NULL,
    "outcome" "CallbackOutcomeType" NOT NULL,
    "stonegateLeadId" TEXT,
    "summary" TEXT,
    "callbackAt" TIMESTAMP(3) NOT NULL,
    "contractAmountCents" INTEGER,
    "revenueCents" INTEGER,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallbackOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" UUID NOT NULL,
    "normalizedPhone" TEXT NOT NULL,
    "contactId" UUID,
    "reason" "SuppressionReason" NOT NULL,
    "source" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "campaignId" UUID,
    "fileName" TEXT NOT NULL,
    "status" "ImportStatus" NOT NULL DEFAULT 'STAGING',
    "columnMapping" JSONB NOT NULL,
    "uploadedCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "invalidCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "suppressedCount" INTEGER NOT NULL DEFAULT 0,
    "missingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" UUID NOT NULL,
    "importBatchId" UUID NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "status" "ImportRowStatus" NOT NULL,
    "normalizedPhone" TEXT,
    "mappedData" JSONB NOT NULL,
    "rawData" JSONB NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" UUID NOT NULL,
    "jobId" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "campaignId" UUID,
    "entityId" UUID,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Campaign_status_createdAt_idx" ON "Campaign"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_createdAt_idx" ON "Campaign"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_normalizedPhone_key" ON "Contact"("normalizedPhone");

-- CreateIndex
CREATE INDEX "Contact_externalId_idx" ON "Contact"("externalId");

-- CreateIndex
CREATE INDEX "Property_externalId_idx" ON "Property"("externalId");

-- CreateIndex
CREATE INDEX "Property_propertyAddress_city_state_idx" ON "Property"("propertyAddress", "city", "state");

-- CreateIndex
CREATE INDEX "ContactProperty_propertyId_idx" ON "ContactProperty"("propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactProperty_contactId_propertyId_key" ON "ContactProperty"("contactId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContact_importRowId_key" ON "CampaignContact"("importRowId");

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_status_idx" ON "CampaignContact"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignContact_contactId_createdAt_idx" ON "CampaignContact"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_isPreview_idx" ON "CampaignContact"("campaignId", "isPreview");

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_selectedForSend_status_idx" ON "CampaignContact"("campaignId", "selectedForSend", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContact_campaignId_contactId_propertyId_key" ON "CampaignContact"("campaignId", "contactId", "propertyId");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptTemplate_name_key" ON "ScriptTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ScriptTemplateVersion_templateId_version_key" ON "ScriptTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceConfiguration_name_key" ON "VoiceConfiguration"("name");

-- CreateIndex
CREATE INDEX "AudioAsset_campaignContactId_status_idx" ON "AudioAsset"("campaignContactId", "status");

-- CreateIndex
CREATE INDEX "AudioAsset_textHash_idx" ON "AudioAsset"("textHash");

-- CreateIndex
CREATE UNIQUE INDEX "AudioAsset_campaignContactId_textHash_voiceId_modelId_key" ON "AudioAsset"("campaignContactId", "textHash", "voiceId", "modelId");

-- CreateIndex
CREATE UNIQUE INDEX "Drop_providerMessageId_key" ON "Drop"("providerMessageId");

-- CreateIndex
CREATE INDEX "Drop_status_createdAt_idx" ON "Drop"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Drop_campaignContactId_idx" ON "Drop"("campaignContactId");

-- CreateIndex
CREATE UNIQUE INDEX "Drop_campaignContactId_provider_key" ON "Drop"("campaignContactId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryEvent_providerEventId_key" ON "DeliveryEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "DeliveryEvent_dropId_receivedAt_idx" ON "DeliveryEvent"("dropId", "receivedAt");

-- CreateIndex
CREATE INDEX "DeliveryEvent_eventType_receivedAt_idx" ON "DeliveryEvent"("eventType", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallbackOutcome_idempotencyKey_key" ON "CallbackOutcome"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CallbackOutcome_normalizedPhone_callbackAt_idx" ON "CallbackOutcome"("normalizedPhone", "callbackAt");

-- CreateIndex
CREATE INDEX "CallbackOutcome_campaignId_outcome_idx" ON "CallbackOutcome"("campaignId", "outcome");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionEntry_normalizedPhone_key" ON "SuppressionEntry"("normalizedPhone");

-- CreateIndex
CREATE INDEX "SuppressionEntry_reason_createdAt_idx" ON "SuppressionEntry"("reason", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_key_key" ON "AppSetting"("key");

-- CreateIndex
CREATE INDEX "ImportBatch_status_createdAt_idx" ON "ImportBatch"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ImportRow_importBatchId_status_idx" ON "ImportRow"("importBatchId", "status");

-- CreateIndex
CREATE INDEX "ImportRow_normalizedPhone_idx" ON "ImportRow"("normalizedPhone");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_importBatchId_rowNumber_key" ON "ImportRow"("importBatchId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_jobId_key" ON "JobRun"("jobId");

-- CreateIndex
CREATE INDEX "JobRun_campaignId_createdAt_idx" ON "JobRun"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRun_queue_status_idx" ON "JobRun"("queue", "status");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_scriptTemplateVersionId_fkey" FOREIGN KEY ("scriptTemplateVersionId") REFERENCES "ScriptTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_voiceConfigurationId_fkey" FOREIGN KEY ("voiceConfigurationId") REFERENCES "VoiceConfiguration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProperty" ADD CONSTRAINT "ContactProperty_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactProperty" ADD CONSTRAINT "ContactProperty_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "Property"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_importRowId_fkey" FOREIGN KEY ("importRowId") REFERENCES "ImportRow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScriptTemplateVersion" ADD CONSTRAINT "ScriptTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ScriptTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_scriptTemplateVersionId_fkey" FOREIGN KEY ("scriptTemplateVersionId") REFERENCES "ScriptTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioAsset" ADD CONSTRAINT "AudioAsset_voiceConfigurationId_fkey" FOREIGN KEY ("voiceConfigurationId") REFERENCES "VoiceConfiguration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drop" ADD CONSTRAINT "Drop_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Drop" ADD CONSTRAINT "Drop_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "AudioAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_dropId_fkey" FOREIGN KEY ("dropId") REFERENCES "Drop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallbackOutcome" ADD CONSTRAINT "CallbackOutcome_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallbackOutcome" ADD CONSTRAINT "CallbackOutcome_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
