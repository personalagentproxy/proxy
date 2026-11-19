-- Version history for drives whose files live elsewhere, as Google Drive: a version may be kept
-- only as the drive's own revision, with no blob, and says which revision it holds, what type the
-- file is there, and whether Personal Agent Proxy pinned it. A change gains the kind `edit`, the
-- drive's revisions around it, and its exact inverse where it has one.

-- AlterEnum
ALTER TYPE "FileChangeKind" ADD VALUE 'edit';

-- AlterTable
ALTER TABLE "FileChange" ADD COLUMN     "afterRevision" TEXT,
ADD COLUMN     "beforeRevision" TEXT,
ADD COLUMN     "undo" JSONB;

-- AlterTable
ALTER TABLE "FileVersion" ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sourceRevision" TEXT,
ADD COLUMN     "sourceType" TEXT,
ALTER COLUMN "blobId" DROP NOT NULL,
ALTER COLUMN "size" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "FileVersion_createdAt_idx" ON "FileVersion"("createdAt");
