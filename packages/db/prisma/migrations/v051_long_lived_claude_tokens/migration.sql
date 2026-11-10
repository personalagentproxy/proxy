-- The api no longer mints or refreshes Claude OAuth tokens: a member's Claude credential is a
-- long-lived token, minted on their machine or pasted from `claude setup-token`, or an API key.
-- Accounts connected by the api's own sign-in held a refresh token the api would have gone on
-- refreshing, so they are removed: those members connect again. The profile the api meant to read
-- from the SDK goes with them, and in come the plan's usage as the last turn's rate-limit headers
-- had it. Postgres can't drop a value from an enum, so the enum is made anew.

DELETE FROM "ClaudeAccount" WHERE "kind" = 'oauth';

-- AlterEnum
BEGIN;
CREATE TYPE "ClaudeAccountKind_new" AS ENUM ('setup_token', 'api_key');
ALTER TABLE "ClaudeAccount" ALTER COLUMN "kind" TYPE "ClaudeAccountKind_new" USING ("kind"::text::"ClaudeAccountKind_new");
ALTER TYPE "ClaudeAccountKind" RENAME TO "ClaudeAccountKind_old";
ALTER TYPE "ClaudeAccountKind_new" RENAME TO "ClaudeAccountKind";
DROP TYPE "public"."ClaudeAccountKind_old";
COMMIT;

-- AlterTable
ALTER TABLE "ClaudeAccount" DROP COLUMN "email",
DROP COLUMN "lastRefreshedAt",
DROP COLUMN "subscriptionType",
ADD COLUMN     "usageFiveHourResetsAt" TIMESTAMP(3),
ADD COLUMN     "usageFiveHourUtilization" DOUBLE PRECISION,
ADD COLUMN     "usageReadAt" TIMESTAMP(3),
ADD COLUMN     "usageSevenDayResetsAt" TIMESTAMP(3),
ADD COLUMN     "usageSevenDayUtilization" DOUBLE PRECISION;
