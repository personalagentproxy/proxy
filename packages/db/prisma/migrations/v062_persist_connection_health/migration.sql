CREATE TYPE "ConnectionHealthStatus" AS ENUM ('healthy', 'sign_in_required', 'unreachable', 'unsupported', 'error');

ALTER TABLE "Connection"
ADD COLUMN "healthStatus" "ConnectionHealthStatus",
ADD COLUMN "healthMessage" TEXT,
ADD COLUMN "healthCheckedAt" TIMESTAMP(3);
