-- The built-in agent runs on each member's own Claude account, and on the server's OpenRouter key
-- only for an organization with the `openrouter` experiment (or an insider, which has every
-- experiment). A new persona starts on Claude, and those on OpenRouter elsewhere are moved to it,
-- answering with Sonnet.

-- AlterTable
ALTER TABLE "Persona" ALTER COLUMN "harness" SET DEFAULT 'claude-agent-sdk',
ALTER COLUMN "chatModel" SET DEFAULT 'sonnet';

UPDATE "Persona" AS persona
SET "harness" = 'claude-agent-sdk', "chatModel" = 'sonnet'
FROM "Organization" AS org
WHERE persona."orgId" = org."id"
  AND persona."harness" = 'proxy'
  AND org."insider" = false
  AND NOT ('openrouter' = ANY (org."experiments"));
