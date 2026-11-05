/**
 * Errors as log context. `JSON.stringify` flattens an `Error` to `{}`, since `message` and `stack`
 * are not enumerable, so anything that may hold one is expanded first: the error itself, its
 * `cause` chain, and its own properties, such as an `ApiError`'s `cause`.
 */

/** Expands every `Error` anywhere in `value`; everything else is copied as it is. */
export function expandErrors(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
	if (value instanceof Error) {
		return serializeError(value, seen);
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (seen.has(value)) {
		return '[Circular]';
	}
	seen.add(value);
	if (Array.isArray(value)) {
		return value.map((item) => expandErrors(item, seen));
	}
	return ownEnumerableProps(value, seen);
}

function ownEnumerableProps(value: object, seen: WeakSet<object>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		out[key] = expandErrors(item, seen);
	}
	return out;
}

/** Flattens anything thrown or returned as an error into a log context. */
export function serializeError(
	error: unknown,
	seen: WeakSet<object> = new WeakSet(),
): Record<string, unknown> {
	if (error instanceof Error) {
		if (seen.has(error)) {
			return {name: error.name, message: error.message, circular: true};
		}
		seen.add(error);
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			...(error.cause === undefined ? {} : {cause: serializeError(error.cause, seen)}),
			...ownEnumerableProps(error, seen),
		};
	}

	if (error !== null && typeof error === 'object') {
		return {error: ownEnumerableProps(error, seen)};
	}

	return {error: String(error)};
}
