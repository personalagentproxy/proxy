-- A new file's folders to make on the way, at done, as a push to a path whose folders are missing.

-- AlterTable
ALTER TABLE "FileUpload" ADD COLUMN     "folders" TEXT[] DEFAULT ARRAY[]::TEXT[];
