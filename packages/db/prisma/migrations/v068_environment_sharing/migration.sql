ALTER TABLE "EnvironmentAccess" ADD COLUMN "userId" TEXT, ADD COLUMN "method" TEXT NOT NULL DEFAULT 'runtime';
CREATE TABLE "DevelopmentEnvironmentPersonGrant" (
 "environmentId" TEXT NOT NULL, "memberId" TEXT NOT NULL, "names" TEXT[],
 CONSTRAINT "DevelopmentEnvironmentPersonGrant_pkey" PRIMARY KEY ("environmentId", "memberId")
);
CREATE INDEX "DevelopmentEnvironmentPersonGrant_memberId_idx" ON "DevelopmentEnvironmentPersonGrant"("memberId");
CREATE TABLE "DevelopmentEnvironmentKey" (
 "environmentId" TEXT NOT NULL, "name" TEXT NOT NULL, "service" TEXT NOT NULL, "label" TEXT NOT NULL,
 CONSTRAINT "DevelopmentEnvironmentKey_pkey" PRIMARY KEY ("environmentId", "name")
);
