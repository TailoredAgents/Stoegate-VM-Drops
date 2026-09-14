-- CreateEnum
CREATE TYPE "AudioBillingDisposition" AS ENUM ('BILLABLE_GENERATION', 'DRY_RUN');

-- CreateEnum
CREATE TYPE "AttributionChannel" AS ENUM ('RVM_CALLBACK', 'SMS', 'COLD_CALL', 'OTHER');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('RVM', 'SMS', 'COLD_CALL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OutreachSequenceState" AS ENUM ('RVM_PENDING', 'RVM_SENT', 'RVM_SUCCESS', 'RVM_FAILED', 'RVM_CALLBACK', 'RVM_NO_RESPONSE', 'SMS_NOT_YET_ELIGIBLE', 'SMS_ELIGIBLE', 'SMS_EXPORTED', 'SMS_SENT_EXTERNAL', 'SMS_REPLIED', 'SMS_FAILED', 'SMS_NO_RESPONSE', 'COLD_CALL_NOT_YET_ELIGIBLE', 'COLD_CALL_ELIGIBLE', 'COLD_CALL_EXPORTED', 'COLD_CALL_CONTACTED', 'COLD_CALL_NO_ANSWER', 'INTERESTED', 'QUALIFIED_LEAD', 'FOLLOW_UP', 'NOT_INTERESTED', 'WRONG_NUMBER', 'OPT_OUT', 'CONTRACT', 'CLOSED');

-- CreateEnum
CREATE TYPE "OutreachEventType" AS ENUM ('RVM_PENDING', 'RVM_SENT', 'RVM_SUCCESS', 'RVM_FAILED', 'RVM_CALLBACK', 'RVM_NO_RESPONSE', 'SMS_ELIGIBLE', 'SMS_EXPORTED', 'SMS_SENT_EXTERNAL', 'SMS_REPLIED', 'SMS_FAILED', 'SMS_NO_RESPONSE', 'COLD_CALL_ELIGIBLE', 'COLD_CALL_EXPORTED', 'COLD_CALL_CONTACTED', 'COLD_CALL_NO_ANSWER', 'OUTCOME_RECORDED', 'SEQUENCE_EXITED');

-- CreateEnum
CREATE TYPE "OutreachExportType" AS ENUM ('SMS_ELIGIBILITY', 'BATCH_DIALER');

-- CreateEnum
CREATE TYPE "ExternalOutcomeChannel" AS ENUM ('SMS', 'COLD_CALL');

-- CreateEnum
CREATE TYPE "ExternalOutcomeImportStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ExternalOutcomeRowStatus" AS ENUM ('ACCEPTED', 'REJECTED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "RvmUsageKind" AS ENUM ('ATTEMPT', 'SUCCESS');

-- AlterTable
ALTER TABLE "AudioAsset" ADD COLUMN     "billingDisposition" "AudioBillingDisposition" NOT NULL DEFAULT 'BILLABLE_GENERATION',
ADD COLUMN     "reuseCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CallbackOutcome" ADD COLUMN     "attributionChannel" "AttributionChannel" NOT NULL DEFAULT 'RVM_CALLBACK';

-- AlterTable
ALTER TABLE "Drop" ADD COLUMN     "carrierDurationSeconds" DOUBLE PRECISION,
ADD COLUMN     "carrierDurationSource" TEXT,
ADD COLUMN     "providerUsageValueCents" INTEGER NOT NULL DEFAULT 0;

-- New campaigns target the 2,000/day operating model. The independent
-- environment ceilings still gate every live campaign and local day.
ALTER TABLE "Campaign" ALTER COLUMN "sendLimit" SET DEFAULT 2000;

-- CreateTable
CREATE TABLE "AudioGenerationUsage" (
    "id" UUID NOT NULL,
    "audioAssetId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerGenerationId" TEXT,
    "characterCount" INTEGER NOT NULL,
    "estimatedCostCents" INTEGER NOT NULL DEFAULT 0,
    "billingDisposition" "AudioBillingDisposition" NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "storedAt" TIMESTAMP(3),
    "storageError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioGenerationUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachSequence" (
    "id" UUID NOT NULL,
    "campaignContactId" UUID NOT NULL,
    "currentState" "OutreachSequenceState" NOT NULL DEFAULT 'RVM_PENDING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "rvmScheduledFor" TIMESTAMP(3),
    "rvmAttemptedAt" TIMESTAMP(3),
    "rvmSuccessfulAt" TIMESTAMP(3),
    "smsEligibleAt" TIMESTAMP(3),
    "smsExportedAt" TIMESTAMP(3),
    "smsSentAt" TIMESTAMP(3),
    "smsRespondedAt" TIMESTAMP(3),
    "coldCallEligibleAt" TIMESTAMP(3),
    "coldCallExportedAt" TIMESTAMP(3),
    "nextEligibleAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "terminalReason" TEXT,
    "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachEvent" (
    "id" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "type" "OutreachEventType" NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "resultingState" "OutreachSequenceState" NOT NULL,
    "outcome" TEXT,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "actorUserId" UUID,
    "rawPayload" JSONB,
    "metadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadAttribution" (
    "id" UUID NOT NULL,
    "campaignContactId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "creditedChannel" "AttributionChannel" NOT NULL,
    "creditedEventId" UUID,
    "qualifyingOutcome" TEXT NOT NULL,
    "attributedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachExport" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" "OutreachExportType" NOT NULL,
    "campaignId" UUID,
    "createdByUserId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "intentionalRepeat" BOOLEAN NOT NULL DEFAULT false,
    "repeatReason" TEXT,
    "filtersSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachExportItem" (
    "id" UUID NOT NULL,
    "exportId" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "campaignContactId" UUID NOT NULL,
    "occurrence" INTEGER NOT NULL DEFAULT 1,
    "rowSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachExportItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachExportClaim" (
    "id" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "type" "OutreachExportType" NOT NULL,
    "firstExportId" UUID NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachExportClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOutcomeImport" (
    "id" UUID NOT NULL,
    "channel" "ExternalOutcomeChannel" NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" "ExternalOutcomeImportStatus" NOT NULL DEFAULT 'PROCESSING',
    "createdByUserId" UUID NOT NULL,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalOutcomeImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalOutcomeImportRow" (
    "id" UUID NOT NULL,
    "importId" UUID NOT NULL,
    "sequenceId" UUID,
    "rowNumber" INTEGER NOT NULL,
    "status" "ExternalOutcomeRowStatus" NOT NULL,
    "result" TEXT,
    "externalId" TEXT,
    "occurredAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "rawData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalOutcomeImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderBillingPeriod" (
    "id" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "actualInvoiceCents" INTEGER,
    "actualCarrierSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderBillingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RvmDailyUsage" (
    "id" UUID NOT NULL,
    "localDate" DATE NOT NULL,
    "timezone" TEXT NOT NULL,
    "cap" INTEGER NOT NULL,
    "attemptedCount" INTEGER NOT NULL DEFAULT 0,
    "successfulCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RvmDailyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RvmUsageLedger" (
    "id" UUID NOT NULL,
    "dailyUsageId" UUID NOT NULL,
    "dropId" UUID NOT NULL,
    "kind" "RvmUsageKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RvmUsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutreachSequence_campaignContactId_key" ON "OutreachSequence"("campaignContactId");

-- CreateIndex
CREATE INDEX "AudioGenerationUsage_audioAssetId_generatedAt_idx" ON "AudioGenerationUsage"("audioAssetId", "generatedAt");

-- CreateIndex
CREATE INDEX "AudioGenerationUsage_billingDisposition_generatedAt_idx" ON "AudioGenerationUsage"("billingDisposition", "generatedAt");

-- CreateIndex
CREATE INDEX "OutreachSequence_currentState_nextEligibleAt_idx" ON "OutreachSequence"("currentState", "nextEligibleAt");

-- CreateIndex
CREATE INDEX "OutreachSequence_smsEligibleAt_idx" ON "OutreachSequence"("smsEligibleAt");

-- CreateIndex
CREATE INDEX "OutreachSequence_coldCallEligibleAt_idx" ON "OutreachSequence"("coldCallEligibleAt");

-- CreateIndex
CREATE INDEX "OutreachSequence_rvmScheduledFor_idx" ON "OutreachSequence"("rvmScheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachEvent_idempotencyKey_key" ON "OutreachEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutreachEvent_sequenceId_occurredAt_idx" ON "OutreachEvent"("sequenceId", "occurredAt");

-- CreateIndex
CREATE INDEX "OutreachEvent_type_occurredAt_idx" ON "OutreachEvent"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "OutreachEvent_channel_outcome_occurredAt_idx" ON "OutreachEvent"("channel", "outcome", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadAttribution_campaignContactId_key" ON "LeadAttribution"("campaignContactId");

-- CreateIndex
CREATE INDEX "LeadAttribution_campaignId_creditedChannel_idx" ON "LeadAttribution"("campaignId", "creditedChannel");

-- CreateIndex
CREATE INDEX "LeadAttribution_creditedChannel_attributedAt_idx" ON "LeadAttribution"("creditedChannel", "attributedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachExport_idempotencyKey_key" ON "OutreachExport"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OutreachExport_type_createdAt_idx" ON "OutreachExport"("type", "createdAt");

-- CreateIndex
CREATE INDEX "OutreachExport_campaignId_createdAt_idx" ON "OutreachExport"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "OutreachExportItem_sequenceId_createdAt_idx" ON "OutreachExportItem"("sequenceId", "createdAt");

-- CreateIndex
CREATE INDEX "OutreachExportItem_campaignContactId_idx" ON "OutreachExportItem"("campaignContactId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachExportItem_exportId_sequenceId_key" ON "OutreachExportItem"("exportId", "sequenceId");

-- CreateIndex
CREATE INDEX "OutreachExportClaim_firstExportId_idx" ON "OutreachExportClaim"("firstExportId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachExportClaim_sequenceId_type_key" ON "OutreachExportClaim"("sequenceId", "type");

-- CreateIndex
CREATE INDEX "ExternalOutcomeImport_channel_createdAt_idx" ON "ExternalOutcomeImport"("channel", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalOutcomeImportRow_sequenceId_idx" ON "ExternalOutcomeImportRow"("sequenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalOutcomeImportRow_importId_rowNumber_key" ON "ExternalOutcomeImportRow"("importId", "rowNumber");

-- CreateIndex
CREATE INDEX "ProviderBillingPeriod_startsAt_endsAt_idx" ON "ProviderBillingPeriod"("startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderBillingPeriod_providerKey_startsAt_endsAt_key" ON "ProviderBillingPeriod"("providerKey", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "RvmDailyUsage_timezone_localDate_idx" ON "RvmDailyUsage"("timezone", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "RvmDailyUsage_localDate_timezone_key" ON "RvmDailyUsage"("localDate", "timezone");

-- CreateIndex
CREATE INDEX "RvmUsageLedger_dailyUsageId_kind_idx" ON "RvmUsageLedger"("dailyUsageId", "kind");

-- CreateIndex
CREATE INDEX "RvmUsageLedger_kind_occurredAt_idx" ON "RvmUsageLedger"("kind", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RvmUsageLedger_dropId_kind_key" ON "RvmUsageLedger"("dropId", "kind");

-- AddForeignKey
ALTER TABLE "OutreachSequence" ADD CONSTRAINT "OutreachSequence_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioGenerationUsage" ADD CONSTRAINT "AudioGenerationUsage_audioAssetId_fkey" FOREIGN KEY ("audioAssetId") REFERENCES "AudioAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "OutreachSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEvent" ADD CONSTRAINT "OutreachEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAttribution" ADD CONSTRAINT "LeadAttribution_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAttribution" ADD CONSTRAINT "LeadAttribution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadAttribution" ADD CONSTRAINT "LeadAttribution_creditedEventId_fkey" FOREIGN KEY ("creditedEventId") REFERENCES "OutreachEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExport" ADD CONSTRAINT "OutreachExport_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExport" ADD CONSTRAINT "OutreachExport_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExportItem" ADD CONSTRAINT "OutreachExportItem_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "OutreachExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExportItem" ADD CONSTRAINT "OutreachExportItem_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "OutreachSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExportItem" ADD CONSTRAINT "OutreachExportItem_campaignContactId_fkey" FOREIGN KEY ("campaignContactId") REFERENCES "CampaignContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExportClaim" ADD CONSTRAINT "OutreachExportClaim_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "OutreachSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExportClaim" ADD CONSTRAINT "OutreachExportClaim_firstExportId_fkey" FOREIGN KEY ("firstExportId") REFERENCES "OutreachExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOutcomeImport" ADD CONSTRAINT "ExternalOutcomeImport_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOutcomeImportRow" ADD CONSTRAINT "ExternalOutcomeImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "ExternalOutcomeImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalOutcomeImportRow" ADD CONSTRAINT "ExternalOutcomeImportRow_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "OutreachSequence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RvmUsageLedger" ADD CONSTRAINT "RvmUsageLedger_dailyUsageId_fkey" FOREIGN KEY ("dailyUsageId") REFERENCES "RvmDailyUsage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RvmUsageLedger" ADD CONSTRAINT "RvmUsageLedger_dropId_fkey" FOREIGN KEY ("dropId") REFERENCES "Drop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing dry-run preview tones were never billable ElevenLabs generations.
UPDATE "AudioAsset"
SET "billingDisposition" = 'DRY_RUN', "estimatedCostCents" = 0
WHERE "providerGenerationId" LIKE 'dry-%';

-- Preserve one auditable usage row for every generation the legacy model had
-- already recorded. New code writes a row immediately after every provider
-- generation, including generations whose later R2 upload fails.
INSERT INTO "AudioGenerationUsage" (
  "id", "audioAssetId", "provider", "providerGenerationId",
  "characterCount", "estimatedCostCents", "billingDisposition",
  "generatedAt", "storedAt", "createdAt"
)
SELECT
  gen_random_uuid(), "id",
  CASE WHEN "billingDisposition" = 'DRY_RUN' THEN 'dry-run-tts' ELSE 'elevenlabs' END,
  "providerGenerationId", "characterCount", "estimatedCostCents",
  "billingDisposition", "generatedAt",
  CASE WHEN "objectKey" IS NOT NULL THEN "generatedAt" ELSE NULL END,
  COALESCE("generatedAt", "createdAt")
FROM "AudioAsset"
WHERE "generatedAt" IS NOT NULL;

-- Existing contacts are enrolled only at the inert RVM_PENDING state. The
-- migration deliberately does not infer delivery or make any legacy row SMS
-- eligible; operators can review historical data without triggering outreach.
INSERT INTO "OutreachSequence" (
  "id", "campaignContactId", "currentState", "version",
  "lastEventAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), cc."id", 'RVM_PENDING', 1,
  cc."createdAt", cc."createdAt", CURRENT_TIMESTAMP
FROM "CampaignContact" cc
ON CONFLICT ("campaignContactId") DO NOTHING;

INSERT INTO "OutreachEvent" (
  "id", "sequenceId", "type", "channel", "resultingState", "source",
  "idempotencyKey", "occurredAt", "recordedAt"
)
SELECT
  gen_random_uuid(), os."id", 'RVM_PENDING', 'RVM', 'RVM_PENDING',
  'orchestration_migration', 'sequence:' || os."campaignContactId" || ':created',
  os."createdAt", CURRENT_TIMESTAMP
FROM "OutreachSequence" os
WHERE NOT EXISTS (
  SELECT 1 FROM "OutreachEvent" oe WHERE oe."sequenceId" = os."id"
)
ON CONFLICT ("idempotencyKey") DO NOTHING;

-- Preserve first-touch attribution for unambiguous historical lead outcomes.
-- This is reporting-only and never advances a legacy sequence.
INSERT INTO "LeadAttribution" (
  "id", "campaignContactId", "campaignId", "creditedChannel",
  "qualifyingOutcome", "attributedAt", "createdAt"
)
SELECT DISTINCT ON (co."campaignContactId")
  gen_random_uuid(), co."campaignContactId", co."campaignId",
  co."attributionChannel", co."outcome"::text, co."callbackAt", CURRENT_TIMESTAMP
FROM "CallbackOutcome" co
WHERE co."campaignContactId" IS NOT NULL
  AND co."campaignId" IS NOT NULL
  AND co."outcome" IN ('INTERESTED', 'QUALIFIED_LEAD', 'CONTRACT', 'CLOSED')
ORDER BY co."campaignContactId", co."callbackAt", co."createdAt"
ON CONFLICT ("campaignContactId") DO NOTHING;

-- These defaults are inserted in the migration because Render's initialDeployHook
-- runs only once. Existing operator edits always win.
INSERT INTO "AppSetting" ("id", "key", "value", "description", "updatedAt") VALUES
  (gen_random_uuid(), 'rvm_to_sms_delay_hours', '24'::jsonb, 'Elapsed hours after successful RVM before SMS eligibility', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'sms_to_cold_call_delay_hours', '48'::jsonb, 'Elapsed hours after an externally recorded SMS send before cold-call eligibility', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'daily_rvm_cap', '2000'::jsonb, 'Editable operating cap for live RVM attempts per local day', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'operations_timezone', '"America/New_York"'::jsonb, 'IANA timezone for operating days, windows, and billing periods', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'rvm_send_window_start', '""'::jsonb, 'Optional local live-RVM window start in HH:MM', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'rvm_send_window_end', '""'::jsonb, 'Optional local live-RVM window end in HH:MM', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'provider_billing_cycle_day', '1'::jsonb, 'Provider billing-cycle start day, from 1 through 28', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'drop_cowboy_monthly_minimum_cents', '25000'::jsonb, 'Account-specific Drop Cowboy BYOC monthly minimum/credit', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'drop_cowboy_success_cost_cents', '1'::jsonb, 'Account-specific Drop Cowboy cost per successful RVM', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'carrier_provider_name', '"Twilio"'::jsonb, 'Editable SIP carrier label', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'carrier_trunk_monthly_cents', '1500'::jsonb, 'Estimated monthly SIP trunk fixed cost', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'carrier_did_monthly_cents', '115'::jsonb, 'Estimated monthly cost per active DID', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'carrier_active_did_count', '1'::jsonb, 'Number of active RVM DIDs', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'carrier_voice_cents_per_minute', '0.66'::jsonb, 'Estimated blended carrier voice rate in cents per minute', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'carrier_average_seconds_per_attempt', '30'::jsonb, 'Forecast duration when actual carrier duration is unavailable', CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'infrastructure_monthly_overhead_cents', '0'::jsonb, 'Optional monthly infrastructure overhead', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
