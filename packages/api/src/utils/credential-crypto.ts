import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

import {ApiErr, type ApiError} from '@proxy/utils';
import {Err, Ok, Result} from 'ts-results-es';

import {env} from './env';

// AES-256-GCM, stored as `v1.<iv>.<tag>.<ciphertext>` in base64url. The version leaves room for
// a new key or cipher later without touching what is already stored.
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

function encryptionKey(): Result<Buffer, ApiError> {
	if (!env.ENCRYPTION_KEY) {
		return Err(ApiErr.internalError(new Error('ENCRYPTION_KEY is not set')));
	}
	return Ok(Buffer.from(env.ENCRYPTION_KEY, 'base64'));
}

export function encryptCredential(plaintext: string): Result<string, ApiError> {
	return encryptionKey().map((key) => {
		const iv = randomBytes(12);
		const cipher = createCipheriv(ALGORITHM, key, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'));
		return [VERSION, ...parts].join('.');
	});
}

/** Fails when the value was stored under another key or has been tampered with. */
export function decryptCredential(stored: string): Result<string, ApiError> {
	const [version, iv, tag, ciphertext] = stored.split('.');
	if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
		return Err(ApiErr.internalError(new Error('Unreadable credential')));
	}

	return encryptionKey().andThen((key) =>
		Result.wrap(() => {
			const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
			decipher.setAuthTag(Buffer.from(tag, 'base64url'));
			return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
		}).mapErr((cause) => ApiErr.internalError(cause)),
	);
}
