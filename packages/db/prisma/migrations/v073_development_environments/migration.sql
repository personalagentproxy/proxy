CREATE TABLE "DevelopmentEnvironment" ("id" TEXT PRIMARY KEY, "orgId" TEXT NOT NULL, "project" TEXT NOT NULL, "ciphertext" TEXT NOT NULL, "names" TEXT[] NOT NULL);
CREATE UNIQUE INDEX "DevelopmentEnvironment_orgId_project_key" ON "DevelopmentEnvironment" ("orgId", "project");
CREATE TABLE "DevelopmentEnvironmentGrant" ("environmentId" TEXT NOT NULL, "agentId" TEXT NOT NULL, "names" TEXT[] NOT NULL, PRIMARY KEY ("environmentId", "agentId"));
CREATE TABLE "EnvironmentAccess" ("id" TEXT PRIMARY KEY, "orgId" TEXT NOT NULL, "project" TEXT NOT NULL, "agentId" TEXT NOT NULL, "names" TEXT[] NOT NULL, "allowed" BOOLEAN NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);

CREATE INDEX "EnvironmentAccess_orgId_createdAt_id_idx" ON "EnvironmentAccess" ("orgId", "createdAt", "id");

CREATE INDEX "DevelopmentEnvironmentGrant_agentId_idx" ON "DevelopmentEnvironmentGrant" ("agentId");
