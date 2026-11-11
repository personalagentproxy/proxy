-- Files: drives kept in Personal Agent Proxy itself. FileNode is a drive's tree, FileVersion what a
-- file held at one time, FileBlob the bytes in the server's blob store, and FileChange each change
-- made to a file, with who made it.

-- CreateEnum
CREATE TYPE "FileChangeKind" AS ENUM ('create', 'write', 'move', 'trash', 'untrash', 'restore');

-- CreateTable
CREATE TABLE "FileNode" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "folder" BOOLEAN NOT NULL DEFAULT false,
    "headVersionId" TEXT,
    "trashedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileVersion" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "blobId" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileBlob" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "backendId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileChange" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "FileChangeKind" NOT NULL,
    "beforeVersion" TEXT,
    "afterVersion" TEXT,
    "beforeParentId" TEXT,
    "beforeName" TEXT,
    "userId" TEXT,
    "agentId" TEXT,
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileNode_connectionId_parentId_idx" ON "FileNode"("connectionId", "parentId");

-- CreateIndex
CREATE INDEX "FileNode_parentId_idx" ON "FileNode"("parentId");

-- CreateIndex
CREATE INDEX "FileNode_trashedAt_idx" ON "FileNode"("trashedAt");

-- CreateIndex
CREATE INDEX "FileVersion_connectionId_fileId_createdAt_idx" ON "FileVersion"("connectionId", "fileId", "createdAt");

-- CreateIndex
CREATE INDEX "FileVersion_blobId_idx" ON "FileVersion"("blobId");

-- CreateIndex
CREATE UNIQUE INDEX "FileBlob_key_key" ON "FileBlob"("key");

-- CreateIndex
CREATE INDEX "FileBlob_createdAt_idx" ON "FileBlob"("createdAt");

-- CreateIndex
CREATE INDEX "FileChange_orgId_createdAt_idx" ON "FileChange"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "FileChange_connectionId_fileId_createdAt_idx" ON "FileChange"("connectionId", "fileId", "createdAt");

-- CreateIndex
CREATE INDEX "FileChange_taskId_idx" ON "FileChange"("taskId");

