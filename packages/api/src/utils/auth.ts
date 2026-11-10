import type {IncomingHttpHeaders} from 'node:http';

import {getAuthenticatedSessionDatabase, setSessionUserAgent} from '@proxy/db/auth';
import {ApiErr, type ApiError, getSessionTokenFromHeader} from '@proxy/utils';
import {Err, Ok, type Result} from 'ts-results-es';

import {hashToken, storedUserAgent} from '../auth/session';
import {log, serializeError} from '../observability/log';

export type AuthenticatedApiRequest = {
	// The Session row the cookie points at, so a route can tell it from the person's others.
	sessionId: string;
	userId: string;
	email: string;
	name?: string;
};

/** Authenticates a user from the session cookie. */
export async function authenticateApiRequest(headers: IncomingHttpHeaders): Promise<Result<AuthenticatedApiRequest, ApiError>> {
	const sessionToken = getSessionTokenFromHeader(headers.cookie);
	if (!sessionToken) {
		return Err(ApiErr.unauthenticated());
	}

	const sessionResult = await getAuthenticatedSessionDatabase(hashToken(sessionToken));
	if (sessionResult.isErr()) {
		return sessionResult;
	}

	const session = sessionResult.value;
	if (!session) {
		return Err(ApiErr.unauthenticated());
	}

	await keepUserAgent(session.id, session.userAgent, headers['user-agent']);

	return Ok({
		sessionId: session.id,
		userId: session.userId,
		email: session.user.email,
		name: session.user.name ?? undefined,
	});
}

// The account page names a session by the User-Agent it was last used with, not the one it signed
// in with: the desktop app updates itself without signing in again, and a session from before
// User-Agents were kept has none. Written only when it changed; a failed write is no reason to
// refuse the request.
async function keepUserAgent(sessionId: string, stored: string | null, header: string | undefined): Promise<void> {
	const userAgent = storedUserAgent(header);
	if (!userAgent || userAgent === stored) {
		return;
	}

	const result = await setSessionUserAgent({sessionId, userAgent});
	if (result.isErr()) {
		log.warn('Failed to keep a session’s User-Agent', serializeError(result.error));
	}
}
