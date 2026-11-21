-- An agent's blob is a file on its way through Personal Agent Proxy: an email's attachment, a
-- drive's file, or bytes sent to a URL, which the agent then puts in a drive or fetches. A blob
-- says which agent made it, so only that agent uses it, and the name and media type its source
-- gave it. Uploads tied to the file they would make are gone: bytes sent to a URL become a blob,
-- and a write takes the blob.

-- AlterTable
ALTER TABLE "FileBlob" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "type" TEXT;

-- DropTable
DROP TABLE "FileUpload";

-- DropEnum
DROP TYPE "FileUploadTarget";

-- DropEnum
DROP TYPE "FileUploadStatus";
