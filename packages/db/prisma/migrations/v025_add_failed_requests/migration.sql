-- A request the agent was allowed to make that then failed, the provider turning it down or out of
-- reach, is logged as failed, with what went wrong, rather than not at all.
ALTER TYPE "AuditOutcome" ADD VALUE 'failed';

ALTER TABLE "AuditEntry" ADD COLUMN "error" TEXT;
