import {createHash, randomBytes} from 'node:crypto';

import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError} from '@proxy/utils';

import {timingSafeEqualString} from '../auth/session';
import {env} from '../utils/env';

/**
 * Personal Agent Proxy is its own OAuth 2.1 authorization server for the MCP server: the issuer is
 * `APP_URL`, and the one resource it gives tokens for is `<APP_URL>/mcp`. Codes and tokens are
 * random, and stored only as their SHA-256.
 */

export const OAUTH_SCOPE = 'mcp';

// A code is exchanged right after the browser comes back; an access token lasts an hour and is
// refreshed with a refresh token that lasts 60 days, replaced each time it is used.
export const CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;

export function requireAppUrl(): Result<string, ApiError> {
	if (!env.APP_URL) {
		return Err(ApiErr.internalError(new Error('APP_URL is not set')));
	}
	return Ok(env.APP_URL);
}

export function mcpResourceUrl(appUrl: string): string {
	return `${appUrl}/mcp`;
}

export function resourceMetadataUrl(appUrl: string): string {
	return `${appUrl}/.well-known/oauth-protected-resource/mcp`;
}

export function randomToken(): string {
	return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** Whether a PKCE verifier is the one the S256 challenge was made from. */
export function verifiesPkce(verifier: string, challenge: string): boolean {
	return timingSafeEqualString(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

// A loopback address, where a native client such as Claude Code listens for its redirect.
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Schemes that run or read something in the browser rather than hand the code to an app.
const UNSAFE_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'];

/**
 * A redirect URI a client may register: HTTPS, plain HTTP only to a loopback address, or an app's
 * own scheme such as `cursor://`; never with a fragment.
 */
export function isAllowedRedirectUri(raw: string): boolean {
	if (!URL.canParse(raw)) {
		return false;
	}
	const url = new URL(raw);
	if (url.hash || url.username || url.password) {
		return false;
	}
	if (url.protocol === 'https:') {
		return true;
	}
	if (url.protocol === 'http:') {
		return LOOPBACK_HOSTS.includes(url.hostname);
	}
	return !UNSAFE_SCHEMES.includes(url.protocol);
}

/** `uri` with the params added to its query, as a redirect back to a client carries its result. */
export function withParams(uri: string, params: Record<string, string | null>): string {
	const url = new URL(uri);
	for (const [key, value] of Object.entries(params)) {
		if (value !== null) {
			url.searchParams.set(key, value);
		}
	}
	return url.toString();
}
