import type {Request, RequestHandler, Response} from 'express';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {log, serializeError} from '../../observability/log';
import {authenticateApiRequest, type AuthenticatedApiRequest} from '../../utils/auth';
import {sendApiError, sendResult} from '../response';

/** A request that has passed through `withAuth` — `user` is guaranteed set. */
export type AuthenticatedRequest = Request & {user: AuthenticatedApiRequest};

export type AuthenticatedHandler = (req: AuthenticatedRequest, res: Response) => Promise<void>;

/**
 * Result-returning handler shape. The wrapper writes the response (JSON for `Ok<T>` with
 * `T !== void`, 204 for `Ok<void>`, error envelope for `Err`). Use this for plain JSON endpoints;
 * reach for `AuthenticatedHandler` when you need to stream or own the response yourself.
 */
export type AuthenticatedResultHandler<T> = (req: AuthenticatedRequest) => Promise<Result<T, ApiError>>;

/**
 * Wraps a handler that requires a signed-in user: 401 up front when there is none, then the
 * handler runs with `user` set. Also turns a thrown error into a 500, like `wrapAsyncRoute`.
 */
export function withAuth(routeLabel: string, handler: AuthenticatedHandler): RequestHandler {
	return (req, res) => {
		void (async () => {
			const result = await authenticateApiRequest(req.headers);
			if (result.isErr()) {
				sendApiError(res, result.error);
				return;
			}
			const authed = req as AuthenticatedRequest;
			authed.user = result.value;
			await handler(authed, res);
		})().catch((error: unknown) => {
			log.error('route handler threw', {routeLabel, ...serializeError(error)});
			if (res.headersSent) {
				return;
			}
			res.status(500).json({error: 'internal_error'});
		});
	};
}

/** Variant of `withAuth` for handlers that return a `Result<T, ApiError>`; it writes the response. */
export function withAuthResult<T>(routeLabel: string, handler: AuthenticatedResultHandler<T>): RequestHandler {
	return withAuth(routeLabel, async (req, res) => {
		sendResult(res, await handler(req));
	});
}
