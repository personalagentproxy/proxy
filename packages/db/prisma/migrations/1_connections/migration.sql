-- CreateEnum
CREATE TYPE "Access" AS ENUM ('none', 'read', 'write');

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "credential" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectionDefault" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "access" "Access" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectionDefault_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Connection_orgId_idx" ON "Connection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionDefault_connectionId_collectionId_key" ON "ConnectionDefault"("connectionId", "collectionId");

