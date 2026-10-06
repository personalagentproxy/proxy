import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError} from './api-error';

/**
 * Run a zod schema against an unknown value and lift the result into
 * `Result<T, ApiError>` so it composes inside `Do`. Failures map to
 * `parse_error` (HTTP 400).
 */
export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): Result<T, ApiError> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		return Err(ApiErr.parseError(parsed.error.message));
	}
	return Ok(parsed.data);
}

/**
 * Narrow `T | null | undefined` to `T`, short-circuiting with the supplied
 * error otherwise. Pairs with `Do` for the common pattern of "row exists or
 * 404 / 403".
 */
export function requirePresent<T, E>(value: T | null | undefined, error: E): Result<T, E> {
	if (value === null || value === undefined) {
		return Err(error);
	}
	return Ok(value);
}
