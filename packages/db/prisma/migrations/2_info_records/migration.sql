-- AlterTable
ALTER TABLE "Connection" ALTER COLUMN "credential" DROP NOT NULL;

-- CreateTable
CREATE TABLE "InfoRecord" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "values" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InfoRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InfoRecord_connectionId_collectionId_idx" ON "InfoRecord"("connectionId", "collectionId");


-- Every organization made before this gets its Information connection.
INSERT INTO "Connection" ("id", "orgId", "integrationId", "account")
SELECT 'info-' || "id", "id", 'info', "name" FROM "Organization";
