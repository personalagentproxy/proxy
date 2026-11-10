-- The files a member put in a conversation's input and hasn't sent, kept with what they typed there:
-- each one of a drive's at the version it held then, as JSON, emptied by the message they send.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "draftAttachments" TEXT;

