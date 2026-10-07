import {createHash, randomBytes} from 'node:crypto';

import type {IncomingHttpHeaders} from 'node:http';
import type {Request, Response} from 'express';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {createAgentSession, deleteAgentSession, getAgentForSignIn, getSignedInAgent, type SignedInAgent} from '@proxy/db/agent';
import {agentSessionCookieNames, ApiErr, type ApiError, Do, getAgentSessionTokenFromHeader, parseSchema, requirePresent} from '@proxy/utils';

import {sessionCookieOptions, useSecureCookies} from '../auth/session';
import {log, serializeError} from '../observability/log';
import {sendApiError} from '../server/response';

/**
 * Agent sign-in: a username and the password shown once when the login was made. A session is a
 * random token in the agent's cookie; the database keeps only its SHA-256, so a leaked table signs
 * no one in. Revoking the agent or resetting its password ends its sessions.
 */

const agentSessionMaxAgeSeconds = 7 * 24 * 60 * 60;

// Checked against when the username is unknown, so a wrong username takes as long as a wrong
// password and doesn't give away which usernames exist.
const unknownUsernameHash = Bun.password.hash(randomBytes(16).toString('hex'));

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function agentSessionCookieName(): string {
	if (useSecureCookies()) {
		return agentSessionCookieNames.secure;
	}
	return agentSessionCookieNames.insecure;
}

const loginBodySchema = z.object({username: z.string().trim().min(1), password: z.string().min(1)});

/** Wrong username or password is a 401; the right password of a revoked login is a 403. */
async function signIn(body: unknown): Promise<Result<{agentId: string; token: string; expires: Date}, ApiError>> {
	return Do(async ($) => {
		const {username, password} = $(parseSchema(loginBodySchema, body));
		const agent = $(await getAgentForSignIn(username));
		const matches = await Bun.password.verify(password, agent?.passwordHash ?? (await unknownUsernameHash));
		if (!agent || !matches) {
			return $(Err(ApiErr.unauthenticated()));
		}

		if (agent.revokedAt !== null) {
			return $(Err(ApiErr.forbidden()));
		}

		const token = randomBytes(32).toString('hex');
		const expires = new Date(Date.now() + agentSessionMaxAgeSeconds * 1000);
		$(await createAgentSession({tokenHash: hashToken(token), agentId: agent.id, expires}));
		return {agentId: agent.id, token, expires};
	});
}

/** `POST /agent-auth/login` */
export async function handleAgentLoginRoute(req: Request, res: Response): Promise<void> {
	const result = await signIn(req.body);
	if (result.isErr()) {
		sendApiError(res, result.error);
		return;
	}

	const {agentId, token, expires} = result.value;
	res.cookie(agentSessionCookieName(), token, {...sessionCookieOptions(), expires});
	res.json({agentId});
}

/** `POST /agent-auth/logout`. Succeeds without a session too, like the human sign-out. */
export async function handleAgentLogoutRoute(req: Request, res: Response): Promise<void> {
	const token = getAgentSessionTokenFromHeader(req.headers.cookie);
	if (token) {
		const deleted = await deleteAgentSession(hashToken(token));
		if (deleted.isErr()) {
			log.error('Agent sign-out failed to delete session', serializeError(deleted.error));
			res.status(500).json({error: 'signout_failed'});
			return;
		}
	}

	res.clearCookie(agentSessionCookieName(), sessionCookieOptions());
	res.json({ok: true});
}

/** The agent the request's cookie signs in, or unauthenticated. */
export async function authenticateAgentRequest(headers: IncomingHttpHeaders): Promise<Result<SignedInAgent, ApiError>> {
	return Do(async ($) => {
		const token = $(requirePresent(getAgentSessionTokenFromHeader(headers.cookie), ApiErr.unauthenticated()));
		const agent = $(await getSignedInAgent(hashToken(token)));
		return $(requirePresent(agent, ApiErr.unauthenticated()));
	});
}
