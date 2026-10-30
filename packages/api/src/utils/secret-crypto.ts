import {ApiErr, type ApiError} from '@proxy/utils';
import {secretCipher, type SecretCipher} from '@proxy/utils/secret-crypto';
import {Err, Ok, type Result} from 'ts-results-es';

import {env} from './env';

// The api's cipher (@proxy/utils/secret-crypto), under ENCRYPTION_KEY.
function cipher(): Result<SecretCipher, ApiError> {
	if (!env.ENCRYPTION_KEY) {
		return Err(ApiErr.internalError(new Error('ENCRYPTION_KEY is not set')));
	}
	return Ok(secretCipher(Buffer.from(env.ENCRYPTION_KEY, 'base64')));
}

export function encryptSecret(plaintext: string): Result<string, ApiError> {
	return cipher().map((under) => under.encrypt(plaintext));
}

/** Fails when the value was stored under another key or has been tampered with. */
export function decryptSecret(stored: string): Result<string, ApiError> {
	return cipher().andThen((under) => under.decrypt(stored).mapErr((cause) => ApiErr.internalError(cause)));
}
