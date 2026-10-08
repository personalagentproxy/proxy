import type {Request, Response} from 'express';
import {Err, type Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {createOAuthGrant, getOAuthClient, getOAuthGrantByRefreshToken, rotateOAuthGrant, takeOAuthCode, type OAuthClientRow, type OAuthTokens} from '@proxy/db/oauth';

import {timingSafeEqualString} from '../auth/session';
import {log, serializeError} from '../observability/log';
import {ACCESS_TOKEN_TTL_SECONDS, hashToken, OAUTH_SCOPE, randomToken, REFRESH_TOKEN_TTL_MS, verifiesPkce} from './oauth-config';
import {sendOAuthError, type OAuthError} from './oauth-error';

/**
 * The token endpoint: a code, with its PKCE verifier, for an access token and a refresh token;
 * then a refresh token for new ones, the old refresh token stopping there. A client registered
 * with a secret signs in with it, in the body or as HTTP Basic.
 */

type TokenResponse = {access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string};

function invalidGrant(description: string): OAuthError {
	return {status: 400, error: 'invalid_grant', description};
}

function serverError(error: ApiError): OAuthError {
	log.error('OAuth token request failed', serializeError(error));
	return {status: 500, error: 'server_error', description: 'Something went wrong'};
}

function field(body: Record<string, unknown>, name: string): string | null {
	const value = body[name];
	return typeof value === 'string' && value !== '' ? value : null;
}

// HTTP Basic, as `client_secret_basic` sends the client's id and secret, each form-encoded.
function basicCredentials(header: string | undefined): {id: string; secret: string} | null {
	if (!header?.startsWith('Basic ')) {
		return null;
	}
	const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
	const colon = decoded.indexOf(':');
	if (colon < 0) {
		return null;
	}
	return {id: decodeURIComponent(decoded.slice(0, colon)), secret: decodeURIComponent(decoded.slice(colon + 1))};
}

function authenticateClient(req: Request, body: Record<string, unknown>): Promise<Result<OAuthClientRow, OAuthError>> {
	return Do(async ($) => {
		const basic = basicCredentials(req.headers.authorization);
		const id = basic?.id ?? field(body, 'client_id');
		const secret = basic?.secret ?? field(body, 'client_secret');
		const unknown: OAuthError = {status: 401, error: 'invalid_client', description: 'Unknown client, or the wrong secret'};
		if (!id) {
			return $(Err(unknown));
		}
		const client = $((await getOAuthClient(id)).mapErr(serverError));
		if (!client) {
			return $(Err(unknown));
		}
		if (client.secretHash && !(secret && timingSafeEqualString(hashToken(secret), client.secretHash))) {
			return $(Err(unknown));
		}
		return client;
	});
}

function newTokens(): {tokens: TokenResponse; stored: OAuthTokens} {
	const access = randomToken();
	const refresh = randomToken();
	return {
		tokens: {access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: OAUTH_SCOPE},
		stored: {
			accessTokenHash: hashToken(access),
			accessExpires: new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000),
			refreshTokenHash: hashToken(refresh),
			refreshExpires: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
		},
	};
}

function exchangeCode(client: OAuthClientRow, body: Record<string, unknown>): Promise<Result<TokenResponse, OAuthError>> {
	return Do(async ($) => {
		const code = field(body, 'code');
		const verifier = field(body, 'code_verifier');
		if (!code || !verifier) {
			return $(Err({status: 400, error: 'invalid_request', description: 'code and code_verifier are required'}));
		}
		const stored = $((await takeOAuthCode(hashToken(code))).mapErr(serverError));
		if (!stored || stored.clientId !== client.id || stored.expires <= new Date()) {
			return $(Err(invalidGrant('The code is unknown, used or expired')));
		}
		const redirectUri = field(body, 'redirect_uri');
		if (redirectUri !== null && redirectUri !== stored.redirectUri) {
			return $(Err(invalidGrant('redirect_uri is not the one the code was made for')));
		}
		if (!verifiesPkce(verifier, stored.codeChallenge)) {
			return $(Err(invalidGrant('The code_verifier does not match')));
		}

		const {tokens, stored: hashes} = newTokens();
		$((await createOAuthGrant({...hashes, clientId: client.id, agentId: stored.agentId})).mapErr(serverError));
		return tokens;
	});
}

function refresh(client: OAuthClientRow, body: Record<string, unknown>): Promise<Result<TokenResponse, OAuthError>> {
	return Do(async ($) => {
		const token = field(body, 'refresh_token');
		if (!token) {
			return $(Err({status: 400, error: 'invalid_request', description: 'refresh_token is required'}));
		}
		const previous = hashToken(token);
		const grant = $((await getOAuthGrantByRefreshToken(previous)).mapErr(serverError));
		if (!grant || grant.clientId !== client.id || grant.refreshExpires <= new Date() || grant.agentRevoked) {
			return $(Err(invalidGrant('The refresh token is unknown, used or expired')));
		}

		const {tokens, stored} = newTokens();
		const rotated = $((await rotateOAuthGrant(grant.id, previous, stored)).mapErr(serverError));
		if (!rotated) {
			return $(Err(invalidGrant('The refresh token was used already')));
		}
		return tokens;
	});
}

function issue(req: Request): Promise<Result<TokenResponse, OAuthError>> {
	return Do(async ($) => {
		const body: Record<string, unknown> = typeof req.body === 'object' && req.body !== null ? req.body : {};
		const client = $(await authenticateClient(req, body));
		const grantType = field(body, 'grant_type');
		if (grantType === 'authorization_code') {
			return $(await exchangeCode(client, body));
		}
		if (grantType === 'refresh_token') {
			return $(await refresh(client, body));
		}
		return $(Err({status: 400, error: 'unsupported_grant_type', description: 'Use authorization_code or refresh_token'}));
	});
}

/** `POST /oauth/token`, form-encoded as OAuth sends it, or JSON. */
export async function handleTokenRoute(req: Request, res: Response): Promise<void> {
	const result = await issue(req);
	if (result.isErr()) {
		if (result.error.status === 401) {
			res.setHeader('WWW-Authenticate', 'Basic realm="Personal Agent Proxy"');
		}
		sendOAuthError(res, result.error);
		return;
	}
	res.setHeader('Cache-Control', 'no-store');
	res.json(result.value);
}
