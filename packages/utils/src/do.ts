import {Err, Ok, type Result} from 'ts-results-es';

const ErrSymbol = Symbol('DoErr');

type Unwrap<E> = <U>(result: Result<U, E>) => U;

/**
 * Do-notation style helper for chaining Result operations.
 *
 * Allows writing sequential Result operations without manual error checking.
 * The `$` function "unwraps" a Result - returns the value if Ok, or short-circuits
 * the entire block with the error if Err.
 *
 * Works with both sync and async callbacks:
 *
 * @example
 * ```ts
 * // Async
 * const result = await Do(async $ => {
 *   const user = $(await getUser(id));
 *   const project = $(await getProject(user.projectId));
 *   return project.name;
 * });
 *
 * // Sync
 * const result = Do($ => {
 *   const a = $(parseA(input));
 *   const b = $(parseB(input));
 *   return {a, b};
 * });
 * ```
 */
export function Do<T, E>(fn: (unwrap: Unwrap<E>) => Promise<T>): Promise<Result<T, E>>;
export function Do<T, E>(fn: (unwrap: Unwrap<E>) => T): Result<T, E>;
export function Do<T, E>(
	fn: (unwrap: Unwrap<E>) => T | Promise<T>,
): Result<T, E> | Promise<Result<T, E>> {
	let capturedErr: E;

	const unwrap = <U>(result: Result<U, E>): U => {
		if (result.isErr()) {
			capturedErr = result.error;
			throw ErrSymbol;
		}
		return result.value;
	};

	try {
		const value = fn(unwrap);
		if (value instanceof Promise) {
			return value.then(
				(resolved) => Ok(resolved),
				(e) => {
					if (e === ErrSymbol) {
						return Err(capturedErr!);
					}
					throw e;
				},
			);
		}
		return Ok(value);
	} catch (e) {
		if (e === ErrSymbol) {
			return Err(capturedErr!);
		}
		throw e;
	}
}
