-- Whether the member archived a thread, which hides it from their chat's list until something
-- more comes into it. No thread is archived yet.

-- AlterTable
ALTER TABLE "AgentThread" ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false;
