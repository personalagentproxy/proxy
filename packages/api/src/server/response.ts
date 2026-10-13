import type {Response} from 'express';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

/**
 * Writes an `ApiError` as the standard `{error: <kind>}` envelope, with the message of one that
 * has words for the person or agent, as a refused value or statement does.
 */
export function sendApiError(response: Response, error: ApiError): void {
	const message = 'message' in error ? {message: error.message} : {};
	response.status(error.statusCode).json({error: error.kind, ...message});
}

/** Writes a route's `Result`: the error envelope, the value as JSON, or 204 for a `void` value. */
export function sendResult<T>(response: Response, result: Result<T, ApiError>): void {
	if (result.isErr()) {
		sendApiError(response, result.error);
		return;
	}
	if (result.value === undefined) {
		response.status(204).end();
		return;
	}
	response.json(result.value);
}
