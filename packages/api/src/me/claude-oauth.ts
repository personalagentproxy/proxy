import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, type FetchError, httpRequest} from '@proxy/utils';
import type {ClaudeAccountKind} from '@proxy/contracts/me';

/**
 * Signing in to a Claude subscription: the flow `claude setup-token` runs, done by the api in its
 * place. Claude Code's public OAuth client with PKCE, Claude's manual code page as the redirect,
 * where the person is shown a code and pastes it back, and the code traded for an access token
 * and a refresh token. Unlike the connect flow's providers, the token endpoint takes the `state`
 * in its body too, and the pasted code carries it after a `#`. Here are the constants and the
 * pure pieces: the sign-in page's address, reading the pasted code, the exchange, the refresh,
 * and telling a pasted token's kind.
 */

export const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
/** Claude Code's public OAuth client, which every `claude` install signs in with. */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const SCOPES = ['user:profile', 'user:inference'];

const SETUP_TOKEN_PREFIX = 'sk-ant-oat01-';
const API_KEY_PREFIX = 'sk-ant-api';

// What a failed refresh means for the credential, by the token endpoint's status.
const GRANT_GONE = [400, 401];
const RETRIES = 2;
const RETRY_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 8_000;

export const SIGN_IN_FAILED = 'Claude sign-in failed. Try again.';
export const SIGN_IN_EXPIRED = 'Your Claude sign-in expired or was refused. Connect it again on the Account page.';
export const INCOMPLETE_CODE = 'Paste the complete code from Claude.';
export const OTHER_ATTEMPT_CODE = 'This code is from a different sign-in attempt. Open Claude again and paste the new code.';
export const UNKNOWN_TOKEN = 'Paste a token from `claude setup-token` or an Anthropic API key.';

/** A sign-in's tokens: what the credential column holds, decrypted. */
export type OauthCredential = {accessToken: string; refreshToken: string; expiresAt: Date; scopes: string[]};

/** Claude's sign-in page for this attempt: it shows a code bound to `state` once the person agrees. */
export function authorizeUrl({challenge, state}: {challenge: string; state: string}): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set('code', 'true');
	url.searchParams.set('client_id', CLIENT_ID);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('redirect_uri', REDIRECT_URI);
	url.searchParams.set('scope', SCOPES.join(' '));
	url.searchParams.set('code_challenge', challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('state', state);
	return url.toString();
}

/**
 * The code out of what the person pasted, `<code>#<state>`, once its state is the attempt's; the
 * last `#` splits it, should the code hold one.
 */
export function parsePastedCode(pasted: string, expectedState: string): Result<string, ApiError> {
	const trimmed = pasted.trim();
	const at = trimmed.lastIndexOf('#');
	if (at === -1) {
		return Err(ApiErr.validationError(INCOMPLETE_CODE));
	}
	const code = trimmed.slice(0, at);
	const state = trimmed.slice(at + 1);
	if (code === '' || state === '') {
		return Err(ApiErr.validationError(INCOMPLETE_CODE));
	}
	if (state !== expectedState) {
		return Err(ApiErr.validationError(OTHER_ATTEMPT_CODE));
	}
	return Ok(code);
}

const tokenResponseSchema = z.object({
	access_token: z.string(),
	refresh_token: z.string(),
	expires_in: z.number(),
	scope: z.string().optional(),
});

// A refresh may answer without a new refresh token, in which case the old one stays good.
const refreshResponseSchema = tokenResponseSchema.extend({refresh_token: z.string().optional()});

function scopesOf(scope: string | undefined): string[] {
	if (scope === undefined || scope.trim() === '') {
		return SCOPES;
	}
	return scope.split(/\s+/).filter((one) => one !== '');
}

function postToken<S extends z.ZodType>(body: Record<string, string>, schema: S): Promise<Result<z.infer<S>, FetchError>> {
	return httpRequest(TOKEN_URL, {method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'}, body: JSON.stringify(body)}, {schema, timeoutMs: REQUEST_TIMEOUT_MS});
}

/** The pasted code traded for the tokens, with the PKCE verifier and the state the attempt began with. */
export async function exchangeCode({code, verifier, state}: {code: string; verifier: string; state: string}): Promise<Result<OauthCredential, ApiError>> {
	const answered = await postToken({grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier, state}, tokenResponseSchema);
	if (answered.isErr()) {
		if (answered.error.kind === 'http') {
			return Err(ApiErr.unavailable(SIGN_IN_FAILED));
		}
		return Err(ApiErr.providerUnreachable(answered.error, SIGN_IN_FAILED));
	}
	const {access_token, refresh_token, expires_in, scope} = answered.value;
	return Ok({accessToken: access_token, refreshToken: refresh_token, expiresAt: expiresAfter(expires_in), scopes: scopesOf(scope)});
}

function expiresAfter(seconds: number): Date {
	return new Date(Date.now() + seconds * 1000);
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The tokens refreshed: a new access token, and the refresh token rotated where Claude rotated it.
 * A 400 or 401 means the grant is gone, revoked or used up, and only signing in again helps; a
 * 5xx or a network failure is tried twice more, with a short wait between, before giving up.
 */
export async function refreshCredential(credential: OauthCredential): Promise<Result<OauthCredential, ApiError>> {
	let last: FetchError | null = null;
	for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
		if (attempt > 0) {
			await wait(RETRY_BACKOFF_MS * attempt);
		}
		const answered = await postToken({grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: CLIENT_ID}, refreshResponseSchema);
		if (answered.isOk()) {
			const {access_token, refresh_token, expires_in, scope} = answered.value;
			return Ok({
				accessToken: access_token,
				refreshToken: refresh_token ?? credential.refreshToken,
				expiresAt: expiresAfter(expires_in),
				scopes: scope === undefined ? credential.scopes : scopesOf(scope),
			});
		}
		if (answered.error.kind === 'http' && GRANT_GONE.includes(answered.error.status)) {
			return Err(ApiErr.unavailable(SIGN_IN_EXPIRED));
		}
		if (answered.error.kind === 'http' && answered.error.status < 500) {
			return Err(ApiErr.providerUnreachable(answered.error, SIGN_IN_FAILED));
		}
		last = answered.error;
	}
	return Err(ApiErr.providerUnreachable(last, SIGN_IN_FAILED));
}

/** Which kind a pasted token is, by its prefix: `claude setup-token`'s, or an Anthropic API key's. */
export function classifyPastedToken(token: string): Result<Exclude<ClaudeAccountKind, 'oauth'>, ApiError> {
	if (token.startsWith(SETUP_TOKEN_PREFIX)) {
		return Ok('setup_token');
	}
	if (token.startsWith(API_KEY_PREFIX)) {
		return Ok('api_key');
	}
	return Err(ApiErr.validationError(UNKNOWN_TOKEN));
}
