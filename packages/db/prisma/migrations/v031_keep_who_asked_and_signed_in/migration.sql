-- What Personal Agent Proxy does itself from the home page is logged with the member who asked for
-- it, so a write on a shared connection says who made it; null for an agent's request. Every
-- organization has had one member, its owner, who asked for everything done so far.
ALTER TABLE "AuditEntry" ADD COLUMN "userId" TEXT;

UPDATE "AuditEntry" AS e
SET "userId" = o."ownerUserId"
FROM "Organization" AS o
WHERE o."id" = e."orgId" AND e."agentId" IS NULL;

-- An MCP client's sign-in keeps the member who signed it in, from the code on: they see and sign
-- out their own clients on a shared agent, and leaving the organization signs them out, so a former
-- member's client doesn't keep working as a shared agent. Every client so far was signed in by the
-- agent's owner, the organization's one member.
ALTER TABLE "OAuthCode" ADD COLUMN "userId" TEXT;
ALTER TABLE "OAuthGrant" ADD COLUMN "userId" TEXT;

UPDATE "OAuthCode" AS c
SET "userId" = a."ownerUserId"
FROM "Agent" AS a
WHERE a."id" = c."agentId";

UPDATE "OAuthGrant" AS g
SET "userId" = a."ownerUserId"
FROM "Agent" AS a
WHERE a."id" = g."agentId";

-- A code or a grant without an agent, left by one deleted from under it, can't be signed in with.
DELETE FROM "OAuthCode" WHERE "userId" IS NULL;
DELETE FROM "OAuthGrant" WHERE "userId" IS NULL;

ALTER TABLE "OAuthCode" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "OAuthGrant" ALTER COLUMN "userId" SET NOT NULL;

CREATE INDEX "OAuthGrant_userId_idx" ON "OAuthGrant"("userId");
