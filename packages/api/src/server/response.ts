import type {Response} from 'express';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {log, serializeError} from '../observability/log';

/**
 * Writes an `ApiError` as the standard `{error: <kind>}` envelope, with the message of one that
 * has words for the person or agent, as a refused value or statement does, and what is not found,
 * such as `task`, for one that is not.
 */
export function sendApiError(response: Response, error: ApiError): void {
	// A server-side failure is logged here, the one place every route's error passes, with what
	// caused it; a 4xx is the caller's and is not.
	if (error.statusCode >= 500) {
		log.error('request failed', {kind: error.kind, ...('cause' in error ? serializeError(error.cause) : {}), ...('message' in error && error.message ? {detail: error.message} : {})});
	}
	const message = 'message' in error ? {message: error.message} : {};
	const resource = error.kind === 'not_found' ? {resource: error.resource} : {};
	response.status(error.statusCode).json({error: error.kind, ...message, ...resource});
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
