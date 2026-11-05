import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {deleteOtherUserSessions, deleteUserSession, listUserSessions} from '@proxy/db/auth';
import type {Sessions} from '@proxy/contracts/me';

import {log} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {describeUserAgent} from './user-agent';

/** `GET /api/me/sessions` — every browser and desktop app the person is signed in on, the newest first. */
export function handleListSessionsRoute(request: AuthenticatedRequest): Promise<Result<Sessions, ApiError>> {
	return Do(async ($) => {
		const sessions = $(await listUserSessions(request.user.userId));
		return {
			sessions: sessions.map((session) => ({
				id: session.id,
				...describeUserAgent(session.userAgent),
				createdAt: session.createdAt.toISOString(),
				current: session.id === request.user.sessionId,
			})),
		};
	});
}

/**
 * `DELETE /api/me/sessions/:sessionId` — signs one of the person's other sessions out. Not the one
 * asking: that is `POST /auth/signout`, which clears its cookie too.
 */
export function handleDeleteSessionRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const sessionId = request.params.sessionId ?? '';
		if (sessionId === request.user.sessionId) {
			return $(Err(ApiErr.validationError('This is the session you are using; sign out instead.')));
		}

		const deleted = $(await deleteUserSession({userId: request.user.userId, sessionId}));
		if (!deleted) {
			return $(Err(ApiErr.notFound('session', sessionId)));
		}

		log.info('Signed a session out', {userId: request.user.userId});
	});
}

/** `DELETE /api/me/sessions/others` — signs the person out everywhere but here. */
export function handleDeleteOtherSessionsRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const count = $(await deleteOtherUserSessions({userId: request.user.userId, keepSessionId: request.user.sessionId}));
		log.info('Signed the other sessions out', {userId: request.user.userId, count});
	});
}
