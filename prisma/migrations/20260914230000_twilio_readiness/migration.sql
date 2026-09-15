-- Persist read-only provider diagnostics and a separate append-only admin
-- production-approval audit. Neither table can initiate provider traffic.

-- CreateEnum
CREATE TYPE "ProviderDiagnosticStatus" AS ENUM ('PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ProviderApprovalDecision" AS ENUM ('APPROVED', 'REVOKED');

-- Preserve provider failure metadata on every status callback, including
-- callbacks that cannot yet be associated with a local outbound message.
ALTER TABLE "SmsStatusEvent"
ADD COLUMN "errorCode" TEXT,
ADD COLUMN "errorMessage" TEXT;

CREATE INDEX "SmsStatusEvent_providerKey_errorCode_processedAt_idx"
ON "SmsStatusEvent"("providerKey", "errorCode", "processedAt");

CREATE INDEX "SmsOutboundMessage_providerKey_status_errorCode_idx"
ON "SmsOutboundMessage"("providerKey", "status", "errorCode");

CREATE INDEX "SmsOutboundMessage_providerKey_toPhone_fromPhone_idx"
ON "SmsOutboundMessage"("providerKey", "toPhone", "fromPhone");

-- CreateTable
CREATE TABLE "ProviderDiagnosticRun" (
    "id" UUID NOT NULL,
    "providerKey" TEXT NOT NULL,
    "status" "ProviderDiagnosticStatus" NOT NULL,
    "accountFingerprint" TEXT NOT NULL,
    "serviceFingerprint" TEXT NOT NULL,
    "configurationFingerprint" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "checkedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderDiagnosticRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderDiagnosticRun_expiry_check" CHECK ("expiresAt" > "checkedAt")
);

-- CreateTable
CREATE TABLE "ProviderProductionApprovalEvent" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "providerKey" TEXT NOT NULL,
    "decision" "ProviderApprovalDecision" NOT NULL,
    "configurationFingerprint" TEXT NOT NULL,
    "diagnosticRunId" UUID,
    "actorUserId" UUID NOT NULL,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderProductionApprovalEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProviderProductionApprovalEvent_approval_check" CHECK (
      "decision" <> 'APPROVED' OR "diagnosticRunId" IS NOT NULL
    )
);

-- CreateIndex
CREATE INDEX "ProviderDiagnosticRun_providerKey_checkedAt_idx"
ON "ProviderDiagnosticRun"("providerKey", "checkedAt");

CREATE INDEX "ProviderDiagnosticRun_providerKey_status_expiresAt_idx"
ON "ProviderDiagnosticRun"("providerKey", "status", "expiresAt");

CREATE INDEX "ProviderDiagnosticRun_checkedByUserId_checkedAt_idx"
ON "ProviderDiagnosticRun"("checkedByUserId", "checkedAt");

CREATE UNIQUE INDEX "ProviderProductionApprovalEvent_sequence_key"
ON "ProviderProductionApprovalEvent"("sequence");

CREATE INDEX "ProviderProductionApprovalEvent_providerKey_sequence_idx"
ON "ProviderProductionApprovalEvent"("providerKey", "sequence");

CREATE INDEX "ProviderProductionApprovalEvent_actorUserId_occurredAt_idx"
ON "ProviderProductionApprovalEvent"("actorUserId", "occurredAt");

CREATE INDEX "ProviderProductionApprovalEvent_diagnosticRunId_idx"
ON "ProviderProductionApprovalEvent"("diagnosticRunId");

-- AddForeignKey
ALTER TABLE "ProviderDiagnosticRun"
ADD CONSTRAINT "ProviderDiagnosticRun_checkedByUserId_fkey"
FOREIGN KEY ("checkedByUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProviderProductionApprovalEvent"
ADD CONSTRAINT "ProviderProductionApprovalEvent_diagnosticRunId_fkey"
FOREIGN KEY ("diagnosticRunId") REFERENCES "ProviderDiagnosticRun"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProviderProductionApprovalEvent"
ADD CONSTRAINT "ProviderProductionApprovalEvent_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the newly explicit carrier pass-through without overwriting an operator
-- value, and replace only the former untouched provider placeholder.
INSERT INTO "AppSetting" ("id", "key", "value", "description", "updatedAt")
VALUES (
  gen_random_uuid(),
  'sms_carrier_surcharge_per_outbound_segment_micros',
  '0'::jsonb,
  'Estimated carrier surcharge per outbound SMS segment in USD micros',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;

UPDATE "AppSetting"
SET "value" = '"Twilio"'::jsonb,
    "description" = 'Operator-facing SMS provider label',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'sms_provider_display_name'
  AND "value" = '"Not selected"'::jsonb;
