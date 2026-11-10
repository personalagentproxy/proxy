-- The version of the `pap` CLI installed in each sandbox, null for none: the api installs its own
-- before a command run with `pap: true` where it differs.

-- AlterTable
ALTER TABLE "Sandbox" ADD COLUMN "papVersion" TEXT;
