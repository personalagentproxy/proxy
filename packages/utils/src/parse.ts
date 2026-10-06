import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

/**
 * Run a zod schema against an unknown value and lift the result into
 * `Result<T, z.ZodError>` so it composes inside `Do`. Callers translate the
 * error into their own type with `mapErr`.
 */
export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): Result<T, z.ZodError> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		return Err(parsed.error);
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
