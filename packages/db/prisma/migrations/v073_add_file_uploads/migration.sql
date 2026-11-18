-- Uploads into a drive through a URL: what a call said it would send, where the bytes go (a blob
-- of the store here, or the drive's own upload session, encrypted), and where the upload stands.

-- CreateEnum
CREATE TYPE "FileUploadTarget" AS ENUM ('create', 'write');

-- CreateEnum
CREATE TYPE "FileUploadStatus" AS ENUM ('open', 'done', 'failed', 'expired');

-- CreateTable
CREATE TABLE "FileUpload" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "via" "AuditVia" NOT NULL,
    "entryId" TEXT,
    "secretHash" TEXT,
    "target" "FileUploadTarget" NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "fileId" TEXT,
    "version" TEXT,
    "size" BIGINT NOT NULL,
    "sha256" TEXT,
    "type" TEXT NOT NULL,
    "blobId" TEXT,
    "sessionUri" TEXT,
    "status" "FileUploadStatus" NOT NULL DEFAULT 'open',
    "lockedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "afterVersion" TEXT,
    "failure" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FileUpload_secretHash_key" ON "FileUpload"("secretHash");

-- CreateIndex
CREATE INDEX "FileUpload_connectionId_idx" ON "FileUpload"("connectionId");

-- CreateIndex
CREATE INDEX "FileUpload_status_expiresAt_idx" ON "FileUpload"("status", "expiresAt");

