-- Campaign pacing is snapshotted so a campaign cannot silently change when
-- application defaults are edited later.
ALTER TABLE "Campaign"
ADD COLUMN "smsSendIntervalSeconds" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "Campaign"
ADD CONSTRAINT "Campaign_smsSendIntervalSeconds_check"
CHECK ("smsSendIntervalSeconds" BETWEEN 1 AND 3600);

CREATE TYPE "SmsTemplateDraftSource" AS ENUM ('MANUAL', 'OPENAI');

ALTER TABLE "SmsTemplateVersion"
ADD COLUMN "draftSource" "SmsTemplateDraftSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN "aiModel" TEXT,
ADD COLUMN "aiResponseId" TEXT,
ADD COLUMN "aiInstructions" TEXT,
ADD COLUMN "aiRationale" TEXT;

CREATE UNIQUE INDEX "SmsTemplateVersion_aiResponseId_key"
ON "SmsTemplateVersion"("aiResponseId");

ALTER TABLE "SmsTemplateVersion"
ADD CONSTRAINT "SmsTemplateVersion_aiDraftMetadata_check"
CHECK (
  (
    "draftSource" = 'MANUAL'
    AND "aiModel" IS NULL
    AND "aiResponseId" IS NULL
    AND "aiInstructions" IS NULL
    AND "aiRationale" IS NULL
  )
  OR
  (
    "draftSource" = 'OPENAI'
    AND "aiModel" IS NOT NULL
    AND "aiResponseId" IS NOT NULL
    AND "aiInstructions" IS NOT NULL
    AND "aiRationale" IS NOT NULL
  )
);
