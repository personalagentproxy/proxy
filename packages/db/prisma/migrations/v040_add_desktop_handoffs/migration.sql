-- One-time codes that sign the browser in as the desktop app's person, for what has to happen
-- there, such as connecting a service. Kept only as their hash.
-- CreateTable
CREATE TABLE "DesktopHandoff" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "next" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesktopHandoff_codeHash_key" ON "DesktopHandoff"("codeHash");

-- CreateIndex
CREATE INDEX "DesktopHandoff_userId_idx" ON "DesktopHandoff"("userId");

