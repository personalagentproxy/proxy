import {randomBytes} from 'node:crypto';

import type {Response} from 'express';
import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseCookieHeader, parseSchema, requirePresent} from '@proxy/utils';
import {createConnection, listConnections, updateConnectionCredential} from '@proxy/db/connection';
import {findIntegration} from '@proxy/integrations';

import {queryParam, timingSafeEqualString, useSecureCookies} from '../../auth/session';
import {log, serializeError} from '../../observability/log';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {env} from '../../utils/env';
import {decryptSecret, encryptSecret} from '../../utils/secret-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {exchangeGranolaCode, getGranolaAccount, granolaAuthorizeUrl, makePkce, registerGranolaClient} from './granola-oauth';

/**
 * Connecting Granola by signing in to it, as its MCP server asks. Both routes are top-level
 * browser navigations: the start registers Personal Agent Proxy with Granola and sends the browser
 * to Granola's sign-in, keeping the handshake in a short-lived encrypted cookie; the callback
 * trades the code for tokens and makes the connection, or gives an existing one of the same
 * Granola account its new tokens. A new Granola connection lets agents read both its notes and its
 * transcripts by default; either can be turned off on the connection's page.
 */

const stateCookieName = 'proxy.granola-state';
// Only sent to these routes.
const stateCookiePath = '/api/connections/granola';
const stateCookieMaxAgeMs = 15 * 60 * 1000;

const statePayloadSchema = z.object({state: z.string(), verifier: z.string(), clientId: z.string(), userId: z.string()});

type StatePayload = z.infer<typeof statePayloadSchema>;

function redirectUri(appUrl: string): string {
	return `${appUrl}/api/connections/granola/callback`;
}

function stateCookieOptions() {
	return {httpOnly: true, sameSite: 'lax' as const, secure: useSecureCookies(), path: stateCookiePath};
}

function readStateCookie(request: AuthenticatedRequest): Result<StatePayload, ApiError> {
	return Do<StatePayload, ApiError>(($) => {
		const cookie = parseCookieHeader(request.headers.cookie ?? '').get(stateCookieName);
		const stored = $(requirePresent(cookie, ApiErr.validationError('No Granola sign-in under way')));
		const json = $(decryptSecret(stored));
		const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
		return $(parseSchema(statePayloadSchema, parsed));
	});
}

function redirectToConnectError(res: Response, appUrl: string, error: ApiError): void {
	log.warn('Connecting Granola failed', {kind: error.kind, ...('message' in error ? {message: error.message} : {}), ...('cause' in error ? serializeError(error.cause) : {})});
	res.redirect(`${appUrl}/connections/new?error=granola`);
}

/** `GET /api/connections/granola/start` — registers with Granola and sends the browser to its sign-in. */
export async function handleStartGranolaRoute(request: AuthenticatedRequest, res: Response): Promise<void> {
	const appUrl = env.APP_URL;
	if (!appUrl) {
		res.status(500).json({error: 'app_url_not_configured'});
		return;
	}

	const started = await Do<{cookie: string; url: string}, ApiError>(async ($) => {
		const clientId = $(await registerGranolaClient(redirectUri(appUrl)));
		const state = randomBytes(16).toString('hex');
		const {verifier, challenge} = makePkce();
		const cookie = $(encryptSecret(JSON.stringify({state, verifier, clientId, userId: request.user.userId} satisfies StatePayload)));
		return {cookie, url: granolaAuthorizeUrl({clientId, redirectUri: redirectUri(appUrl), state, challenge})};
	});
	if (started.isErr()) {
		redirectToConnectError(res, appUrl, started.error);
		return;
	}

	res.cookie(stateCookieName, started.value.cookie, {...stateCookieOptions(), maxAge: stateCookieMaxAgeMs});
	res.redirect(started.value.url);
}

// The handshake the cookie holds, checked against Granola's answer, then the connection made or
// given its new tokens.
function finishGranolaConnect(request: AuthenticatedRequest, appUrl: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const payload = $(readStateCookie(request));
		const state = queryParam(request, 'state') ?? '';
		if (!timingSafeEqualString(state, payload.state) || payload.userId !== request.user.userId) {
			return $(Err(ApiErr.validationError('Granola sign-in state does not match')));
		}

		const code = queryParam(request, 'code');
		if (!code) {
			return $(Err(ApiErr.validationError(`Granola sign-in ended without a code: ${queryParam(request, 'error') ?? 'unknown'}`)));
		}

		const credential = $(await exchangeGranolaCode({clientId: payload.clientId, redirectUri: redirectUri(appUrl), code, verifier: payload.verifier}));
		const account = $(await getGranolaAccount(credential.accessToken));
		const encrypted = $(encryptSecret(JSON.stringify(credential)));

		const orgId = $(await requireUserOrgId(request));
		const existing = $(await listConnections(orgId)).find((connection) => connection.integrationId === 'granola' && connection.account === account);
		if (existing) {
			$(await updateConnectionCredential({connectionId: existing.id, credential: encrypted}));
			return existing.id;
		}

		const defaults = findIntegration('granola')?.actions.map((action) => action.id) ?? [];
		const row = $(await createConnection({orgId, integrationId: 'granola', account, credential: encrypted, defaults}));
		return row.id;
	});
}

/** `GET /api/connections/granola/callback` — where Granola's sign-in comes back to; lands on the connection. */
export async function handleGranolaCallbackRoute(request: AuthenticatedRequest, res: Response): Promise<void> {
	const appUrl = env.APP_URL;
	if (!appUrl) {
		res.status(500).json({error: 'app_url_not_configured'});
		return;
	}

	// The handshake is single-use: cleared however the callback ends.
	res.clearCookie(stateCookieName, stateCookieOptions());
	const connectionId = await finishGranolaConnect(request, appUrl);
	if (connectionId.isErr()) {
		redirectToConnectError(res, appUrl, connectionId.error);
		return;
	}
	res.redirect(`${appUrl}/connections/${connectionId.value}`);
}
