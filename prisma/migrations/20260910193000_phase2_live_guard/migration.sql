ALTER TABLE "Campaign" ADD COLUMN "launchedByUserId" UUID;

CREATE INDEX "Campaign_launchedByUserId_idx" ON "Campaign"("launchedByUserId");

ALTER TABLE "Campaign"
ADD CONSTRAINT "Campaign_launchedByUserId_fkey"
FOREIGN KEY ("launchedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
