import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';

import {Err, Result} from 'ts-results-es';

// AES-256-GCM, stored as `v1.<iv>.<tag>.<ciphertext>` in base64url. The version leaves room for
// a new key or cipher later without touching what is already stored.
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
// The whole tag, always: told nothing, decryption would take a shortened one, which is far easier
// to forge.
const AUTH_TAG_LENGTH = 16;

/** What is stored of a secret, under one key: the api's, from ENCRYPTION_KEY, 32 bytes. */
export type SecretCipher = {
	encrypt: (plaintext: string) => string;
	/** Fails when the value was stored under another key or has been tampered with. */
	decrypt: (stored: string) => Result<string, Error>;
};

export function secretCipher(key: Buffer): SecretCipher {
	return {
		encrypt: (plaintext) => {
			const iv = randomBytes(12);
			const cipher = createCipheriv(ALGORITHM, key, iv, {authTagLength: AUTH_TAG_LENGTH});
			const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
			const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'));
			return [VERSION, ...parts].join('.');
		},
		decrypt: (stored) => {
			const [version, iv, tag, ciphertext] = stored.split('.');
			if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
				return Err(new Error('Unreadable secret'));
			}

			return Result.wrap(() => {
				const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'), {
					authTagLength: AUTH_TAG_LENGTH,
				});
				decipher.setAuthTag(Buffer.from(tag, 'base64url'));
				const plaintext = Buffer.concat([
					decipher.update(Buffer.from(ciphertext, 'base64url')),
					decipher.final(),
				]);
				return plaintext.toString('utf8');
			}).mapErr((cause) => (cause instanceof Error ? cause : new Error(String(cause))));
		},
	};
}

/**
 * A magic link's token as the database keeps it: hashed with AUTH_SECRET, so the stored value
 * alone signs nobody in.
 */
export function hashVerificationToken(token: string, secret: string): string {
	return createHash('sha256').update(`${token}${secret}`).digest('hex');
}
