-- Requests from the `proxy` command line, which signs in like the agent pages and says it is the
-- command line. Provenance only: access is checked the same whichever way a request came in.
-- AlterEnum
ALTER TYPE "AuditVia" ADD VALUE 'cli';
