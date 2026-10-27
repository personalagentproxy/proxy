import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, type FetchError, httpRequest, parseSchema, requirePresent} from '@proxy/utils';

import type {GoogleClient} from '../../utils/google-oauth-client';
import {decryptSecret} from '../../utils/secret-crypto';
import {PRODUCT_SCOPES} from './scopes';

/**
 * Signing in to Google for a connection: OAuth 2.0 with PKCE against Google's own endpoints, with
 * the client Google sign-in uses (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`), which is
 * confidential, so its secret goes with every token request. Every scope Personal Agent Proxy uses
 * is asked for at once, with offline access for a refresh token; Google's consent screen lets the
 * person untick some, so what was granted is kept beside the tokens.
 */

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const TIMEOUT_MS = 15_000;

// Refreshed a minute early, so a token doesn't run out between the check and the call.
const EXPIRY_MARGIN_MS = 60_000;

/** Every scope a sign-in asks for: the account's address, then Gmail, Calendar, Drive, Contacts and Tasks. */
export const GOOGLE_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email', ...PRODUCT_SCOPES];

/** What a Google connection stores, encrypted: its tokens, the scopes Google granted, and the account. */
export const googleCredentialSchema = z.object({
	accessToken: z.string(),
	refreshToken: z.string().nullable(),
	expiresAt: z.string().nullable(),
	scopes: z.array(z.string()),
	email: z.string(),
});

export type GoogleCredential = z.infer<typeof googleCredentialSchema>;

/** A Google connection's stored credential, decrypted; one that won't decrypt or read is an internal error. */
export function readGoogleCredential(stored: string | null): Result<GoogleCredential, ApiError> {
	const unreadable = (cause: unknown): ApiError => ApiErr.internalError(cause);
	return Do<GoogleCredential, ApiError>(($) => {
		const present = $(requirePresent(stored, unreadable(new Error('Google connection without a credential'))));
		const json = $(decryptSecret(present));
		const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr(unreadable));
		return $(parseSchema(googleCredentialSchema, parsed).mapErr(unreadable));
	});
}

const tokensSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().optional(),
	expires_in: z.number().optional(),
	// Space-separated, as granted.
	scope: z.string().optional(),
	// Only on the first exchange, since `openid` is asked for.
	id_token: z.string().optional(),
});

type Tokens = z.infer<typeof tokensSchema>;

// `sub` is Google's id for the account, which stays as its address changes.
const idTokenPayloadSchema = z.object({sub: z.string().min(1), email: z.string().min(1), email_verified: z.boolean().optional()});

/** Who a sign-in was for: Google's id for the account, and its address as it is now. */
export type GoogleAccount = {id: string; email: string};

// The account a sign-in again is for, as Google takes it in `login_hint`.
const loginHintSchema = z.email();

/**
 * Google's sign-in page for a connection, coming back to `redirectUri` with `state`. Signing in
 * again from a connection names its `account`, so Google opens on it.
 */
export function googleAuthorizeUrl(client: GoogleClient, args: {redirectUri: string; state: string; challenge: string; account: string | null}): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', client.clientId);
	url.searchParams.set('redirect_uri', args.redirectUri);
	url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
	url.searchParams.set('state', args.state);
	url.searchParams.set('code_challenge', args.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	// A refresh token, and on every sign-in, not only the first: Google only sends one with consent.
	url.searchParams.set('access_type', 'offline');
	url.searchParams.set('prompt', 'consent');
	url.searchParams.set('include_granted_scopes', 'true');
	const hint = loginHintSchema.safeParse(args.account);
	if (hint.success) {
		url.searchParams.set('login_hint', hint.data);
	}
	return url.toString();
}

const tokenErrorSchema = z.object({error: z.string()});

// Google answering a token request with `invalid_grant` is the sign-in revoked or the code spent;
// anything else, such as a wrong client secret (`invalid_client`) or too many requests, keeps
// Google's answer as its cause, for the logs.
function tokenError(error: FetchError): ApiError {
	if (error.kind === 'http' && tokenErrorSchema.safeParse(error.body).data?.error === 'invalid_grant') {
		return ApiErr.credentialsRejected();
	}
	return ApiErr.providerUnreachable(error);
}

function requestTokens(client: GoogleClient, params: Record<string, string>): Promise<Result<Tokens, ApiError>> {
	return httpRequest(
		TOKEN_URL,
		{
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({...params, client_id: client.clientId, client_secret: client.clientSecret}).toString(),
		},
		{schema: tokensSchema, timeoutMs: TIMEOUT_MS},
	).then((tokens) => tokens.mapErr(tokenError));
}

function expiresAt(tokens: Tokens): string | null {
	return tokens.expires_in === undefined ? null : new Date(Date.now() + tokens.expires_in * 1000).toISOString();
}

function grantedScopes(tokens: Tokens): string[] | null {
	return tokens.scope === undefined ? null : tokens.scope.split(' ').filter((scope) => scope !== '');
}

// The account from the id_token's payload. It came straight from Google's token endpoint over TLS,
// so the payload is trusted without checking its signature, as Google sign-in does
// (`auth/google.ts`); that saves asking Google's userinfo endpoint for what the token already says.
function accountOf(idToken: string | undefined): Result<GoogleAccount, ApiError> {
	const unreadable = (cause: unknown): ApiError => ApiErr.providerUnreachable(cause);
	const claims = Do<z.infer<typeof idTokenPayloadSchema>, ApiError>(($) => {
		const payload = $(requirePresent(idToken?.split('.')[1], unreadable(new Error('Google answered a sign-in without an id_token'))));
		const json = $(Result.wrap((): unknown => JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).mapErr(unreadable));
		return $(parseSchema(idTokenPayloadSchema, json).mapErr(unreadable));
	});
	return claims.andThen(({sub, email, email_verified: verified}) => {
		if (verified === false) {
			return Err(ApiErr.validationError(`Google hasn't verified ${email}`));
		}
		return Ok({id: sub, email: email.toLowerCase()});
	});
}

/** Trades the code Google sent back for the connection's first tokens, and the account they are for. */
export async function exchangeGoogleCode(
	client: GoogleClient,
	args: {redirectUri: string; code: string; verifier: string},
): Promise<Result<{account: GoogleAccount; credential: GoogleCredential}, ApiError>> {
	const tokens = await requestTokens(client, {grant_type: 'authorization_code', code: args.code, redirect_uri: args.redirectUri, code_verifier: args.verifier});
	return tokens.andThen((value) =>
		accountOf(value.id_token).map((account) => ({
			account,
			credential: {
				accessToken: value.access_token,
				refreshToken: value.refresh_token ?? null,
				expiresAt: expiresAt(value),
				scopes: grantedScopes(value) ?? [],
				email: account.email,
			},
		})),
	);
}

/** New tokens for a connection whose access token ran out; turned down once the sign-in was revoked. */
export async function refreshGoogleTokens(client: GoogleClient, credential: GoogleCredential): Promise<Result<GoogleCredential, ApiError>> {
	if (!credential.refreshToken) {
		return Err(ApiErr.credentialsRejected());
	}
	const tokens = await requestTokens(client, {grant_type: 'refresh_token', refresh_token: credential.refreshToken});
	return tokens.map((value) => ({
		...credential,
		accessToken: value.access_token,
		// Google keeps the refresh token as it is, so its answer usually has none.
		refreshToken: value.refresh_token ?? credential.refreshToken,
		expiresAt: expiresAt(value),
		scopes: grantedScopes(value) ?? credential.scopes,
	}));
}

export function isExpiring(credential: GoogleCredential): boolean {
	return credential.expiresAt !== null && Date.parse(credential.expiresAt) - EXPIRY_MARGIN_MS < Date.now();
}

/**
 * Ends the connection's grant at Google, as disconnecting it does: revoking the refresh token
 * revokes the access tokens made from it too.
 */
export async function revokeGoogleTokens(credential: GoogleCredential): Promise<Result<void, ApiError>> {
	const revoked = await httpRequest(
		REVOKE_URL,
		{
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({token: credential.refreshToken ?? credential.accessToken}).toString(),
		},
		{parse: 'text', timeoutMs: TIMEOUT_MS},
	);
	return revoked.map(() => undefined).mapErr(tokenError);
}
