-- When the provider turned a connection's credential down: it needs signing in to again, and
-- nothing is asked of the provider until it is. The credential is kept.

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "credentialRejectedAt" TIMESTAMP(3);
