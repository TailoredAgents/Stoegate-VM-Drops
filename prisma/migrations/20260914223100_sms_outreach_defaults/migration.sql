-- PostgreSQL requires newly-added enum values to be committed before they can
-- be referenced by a column default. Keep this in a separate migration from
-- the OutreachSequenceState enum extension above.
ALTER TABLE "OutreachSequence"
ALTER COLUMN "currentState" SET DEFAULT 'SMS_PENDING';
