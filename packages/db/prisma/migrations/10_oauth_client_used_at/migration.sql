-- When a client first finished a sign-in, so registrations nobody used can be deleted. A client
-- signed in already counts as used from when it registered.
-- AlterTable
ALTER TABLE "OAuthClient" ADD COLUMN     "usedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OAuthClient_createdAt_idx" ON "OAuthClient"("createdAt");


UPDATE "OAuthClient" SET "usedAt" = "createdAt"
WHERE EXISTS (SELECT 1 FROM "OAuthGrant" WHERE "OAuthGrant"."clientId" = "OAuthClient"."id");
