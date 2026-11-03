-- One-time codes for signing the desktop app in: minted in the browser, bound to the app's PKCE
-- challenge, and traded by the app for a session. Kept only as their hash.
-- CreateTable
CREATE TABLE "DesktopAuthCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesktopAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesktopAuthCode_codeHash_key" ON "DesktopAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "DesktopAuthCode_userId_idx" ON "DesktopAuthCode"("userId");
