-- The files a person attached to what they said in a conversation with the built-in agent, each one
-- of a drive's at the version it held then, with what the model is given of it; without an entry,
-- the files they put in the conversation's input and haven't sent.

-- CreateTable
CREATE TABLE "AgentEntryAttachment" (
    "id" TEXT NOT NULL,
    "entryId" TEXT,
    "threadId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "connectionId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "text" TEXT,
    "cut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEntryAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentEntryAttachment_entryId_idx" ON "AgentEntryAttachment"("entryId");

-- CreateIndex
CREATE INDEX "AgentEntryAttachment_threadId_connectionId_fileId_idx" ON "AgentEntryAttachment"("threadId", "connectionId", "fileId");

