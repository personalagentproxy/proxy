-- Browser sessions keep only the SHA-256 of the cookie's token, as agents' sessions do, so reading
-- the table signs no one in. Hashed in place, the way the api hashes a cookie (hex of the token's
-- SHA-256), so everyone stays signed in.
UPDATE "Session" SET "sessionToken" = encode(sha256(convert_to("sessionToken", 'UTF8')), 'hex');

ALTER TABLE "Session" RENAME COLUMN "sessionToken" TO "tokenHash";

ALTER INDEX "Session_sessionToken_key" RENAME TO "Session_tokenHash_key";

-- Google's tokens from signing in: nothing uses them once the identity is known.
ALTER TABLE "Account" DROP COLUMN "access_token",
DROP COLUMN "expires_at",
DROP COLUMN "id_token",
DROP COLUMN "refresh_token",
DROP COLUMN "scope",
DROP COLUMN "token_type";
