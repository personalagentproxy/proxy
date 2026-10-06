import type {Request, Response} from 'express';

import {deleteSessionByToken} from '@proxy/db/auth';
import {getSessionTokenFromHeader} from '@proxy/utils';

import {log, serializeError} from '../observability/log';
import {clearSessionCookie} from './session';

/**
 * `POST /auth/signout` — deletes the Session row the cookie points at and clears the cookie.
 *
 * Idempotent on purpose: a request without a session (already signed out, expired cookie) still
 * succeeds. The only error is a failed row delete, because the session would then stay valid
 * wherever else the token is held.
 */
export async function handleSignOutRoute(req: Request, res: Response): Promise<void> {
	const sessionToken = getSessionTokenFromHeader(req.headers.cookie);
	if (sessionToken) {
		const deleteResult = await deleteSessionByToken(sessionToken);
		if (deleteResult.isErr()) {
			log.error('Sign-out failed to delete session', serializeError(deleteResult.error));
			res.status(500).json({error: 'signout_failed'});
			return;
		}
	}

	clearSessionCookie(res);
	res.json({ok: true});
}
