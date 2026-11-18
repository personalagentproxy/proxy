-- A write to a drive elsewhere: the drive's revision of the file at the start, and the copy kept of it then, for done to log the write with.

-- AlterTable
ALTER TABLE "FileUpload" ADD COLUMN     "beforeRevision" TEXT,
ADD COLUMN     "beforeVersion" TEXT;
