import {Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, parseSchema} from '@proxy/utils';

/**
 * A list's next page, for a connector whose page holds more than the provider's own token, such as
 * where the list began: written as JSON in base64url, and read back only as one a list gave.
 */
export function writePageToken<T>(page: T): string {
	return Buffer.from(JSON.stringify(page)).toString('base64url');
}

export function readPageToken<T>(schema: z.ZodType<T>, page: string): Result<T, ApiError> {
	const notOne = () => ApiErr.validationError('That page is not one a list gave');
	const json = Result.wrap((): unknown => JSON.parse(Buffer.from(page, 'base64url').toString('utf8')));
	return json.mapErr(notOne).andThen((value) => parseSchema(schema, value).mapErr(notOne));
}
