-- What Personal Agent Proxy does itself from the home page is logged with the member who asked for
-- it, so a write on a shared connection says who made it; null for an agent's request, and for the
-- entries from before.
ALTER TABLE "AuditEntry" ADD COLUMN "userId" TEXT;

-- An MCP client's sign-in keeps the member who signed it in, from the code on: they see and sign
-- out their own clients on a shared agent, and leaving the organization signs them out, so a former
-- member's client doesn't keep working as a shared agent. Null for the grants from before.
ALTER TABLE "OAuthCode" ADD COLUMN "userId" TEXT;
ALTER TABLE "OAuthGrant" ADD COLUMN "userId" TEXT;

CREATE INDEX "OAuthGrant_userId_idx" ON "OAuthGrant"("userId");
