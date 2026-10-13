import type {Result} from 'ts-results-es';
import {Result as ResultClass} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';

import {decryptSecret} from './secret-crypto';

/** What an encrypted JSON value holds, as `schema` reads it: a connection's credential, or a sign-in's handshake cookie. */
export function readStoredJson<T>(stored: string, schema: z.ZodType<T>): Result<T, ApiError> {
	return Do<T, ApiError>(($) => {
		const json = $(decryptSecret(stored));
		const parsed = $(ResultClass.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
		return $(parseSchema(schema, parsed));
	});
}
