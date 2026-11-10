import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, type FetchError, httpRequest, parseSchema} from '@proxy/utils';

import {readStoredJson} from '../../utils/stored-json';
import {GITHUB_API, type GitHubClient, githubHeaders} from './github-app';

/**
 * Signing in to GitHub for a connection: OAuth against GitHub's own endpoints as a GitHub App,
 * with the app's client (`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`), which is confidential, so
 * its secret goes with every token request. A GitHub App has no scopes to ask for: what it may do
 * is set on the app and narrowed when the person installs it, so the sign-in only says who. Its
 * user tokens run out after eight hours where the app expires them, and are refreshed with the
 * refresh token GitHub sends beside them. GitHub answers a token request it turns down with a
 * 200 and an `error`, so both shapes are read.
 */

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

const TIMEOUT_MS = 15_000;

// Refreshed a minute early, so a token doesn't run out between the check and the call.
const EXPIRY_MARGIN_MS = 60_000;

/** What a GitHub connection stores, encrypted: its tokens, and the account, with the name and address commits as them take. */
export const githubCredentialSchema = z.object({
	accessToken: z.string(),
	refreshToken: z.string().nullable(),
	expiresAt: z.string().nullable(),
	// GitHub's id for the account, which stays as its login changes, and the login as it was.
	id: z.string(),
	login: z.string(),
	name: z.string().nullable(),
	email: z.string(),
});

export type GitHubCredential = z.infer<typeof githubCredentialSchema>;

/** A GitHub connection's stored credential, decrypted; one that won't decrypt or read is an internal error. */
export function readGitHubCredential(stored: string | null): Result<GitHubCredential, ApiError> {
	if (stored === null) {
		return Err(ApiErr.internalError(new Error('GitHub connection without a credential')));
	}
	return readStoredJson(stored, githubCredentialSchema).mapErr((error) => (error.kind === 'internal_error' ? error : ApiErr.internalError(new Error('GitHub credential unreadable'))));
}

const tokensSchema = z.object({
	access_token: z.string().min(1),
	expires_in: z.number().optional(),
	refresh_token: z.string().optional(),
	refresh_token_expires_in: z.number().optional(),
});

type Tokens = z.infer<typeof tokensSchema>;

const refusalSchema = z.object({error: z.string(), error_description: z.string().optional()});

const tokenAnswerSchema = z.union([tokensSchema, refusalSchema]);

/** Who a sign-in was for: GitHub's id for the account, its login, and the name and address commits as them take. */
export type GitHubAccount = {id: string; login: string; name: string | null; email: string};

/**
 * GitHub's sign-in page for a connection, coming back to `redirectUri` with `state`. Signing in
 * again from a connection names its `account`, the login, so GitHub opens on it.
 */
export function githubAuthorizeUrl(client: GitHubClient, args: {redirectUri: string; state: string; account: string | null}): string {
	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set('client_id', client.clientId);
	url.searchParams.set('redirect_uri', args.redirectUri);
	url.searchParams.set('state', args.state);
	if (args.account) {
		url.searchParams.set('login', args.account);
	}
	return url.toString();
}

// A code spent or wrong, or a refresh token GitHub won't take any more, is the sign-in to be done
// again; anything else keeps GitHub's answer as its cause, for the logs.
const REJECTED = ['bad_verification_code', 'bad_refresh_token', 'incorrect_client_credentials'];

function refused(error: z.infer<typeof refusalSchema>, url: string): ApiError {
	if (REJECTED.includes(error.error)) {
		return ApiErr.credentialsRejected();
	}
	return ApiErr.providerUnreachable({kind: 'http', url, status: 200, body: error});
}

function requestTokens(client: GitHubClient, params: Record<string, string>): Promise<Result<Tokens, ApiError>> {
	return Do(async ($) => {
		const answer = $(
			(
				await httpRequest(
					TOKEN_URL,
					{
						method: 'POST',
						headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'},
						body: new URLSearchParams({...params, client_id: client.clientId, client_secret: client.clientSecret}).toString(),
					},
					{schema: tokenAnswerSchema, timeoutMs: TIMEOUT_MS},
				)
			).mapErr((error: FetchError) => ApiErr.providerUnreachable(error)),
		);
		if ('error' in answer) {
			return $(Err(refused(answer, TOKEN_URL)));
		}
		return answer;
	});
}

function expiresAt(tokens: Tokens): string | null {
	return tokens.expires_in === undefined ? null : new Date(Date.now() + tokens.expires_in * 1000).toISOString();
}

const userSchema = z.object({id: z.number(), login: z.string().min(1), name: z.string().nullable().optional(), email: z.string().nullable().optional()});

const emailsSchema = z.array(z.object({email: z.string(), primary: z.boolean(), verified: z.boolean()}));

// The address commits as the person take: their primary verified one, which the app reads with
// the Email addresses permission; without it, the one on their profile, or the address GitHub
// gives everyone, which it credits to them too.
async function emailOf(accessToken: string, user: z.infer<typeof userSchema>): Promise<string> {
	const emails = await httpRequest(`${GITHUB_API}/user/emails`, {headers: githubHeaders(accessToken)}, {schema: emailsSchema, timeoutMs: TIMEOUT_MS});
	const primary = emails.isOk() ? emails.value.find((entry) => entry.primary && entry.verified) : undefined;
	return primary?.email ?? user.email ?? `${user.id}+${user.login}@users.noreply.github.com`;
}

/** The account a token is for, as GitHub says. */
export async function githubAccount(accessToken: string): Promise<Result<GitHubAccount, ApiError>> {
	return Do(async ($) => {
		const user = $((await httpRequest(`${GITHUB_API}/user`, {headers: githubHeaders(accessToken)}, {schema: userSchema, timeoutMs: TIMEOUT_MS})).mapErr((error) => ApiErr.providerUnreachable(error)));
		return {id: String(user.id), login: user.login, name: user.name ?? null, email: await emailOf(accessToken, user)};
	});
}

/** Trades the code GitHub sent back for the connection's first tokens, and the account they are for. */
export function exchangeGitHubCode(client: GitHubClient, args: {redirectUri: string; code: string}): Promise<Result<{account: GitHubAccount; credential: GitHubCredential}, ApiError>> {
	return Do(async ($) => {
		const tokens = $(await requestTokens(client, {code: args.code, redirect_uri: args.redirectUri}));
		const account = $(await githubAccount(tokens.access_token));
		return {
			account,
			credential: {accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? null, expiresAt: expiresAt(tokens), ...account},
		};
	});
}

/** New tokens for a connection whose access token ran out; turned down once the sign-in was revoked, or the refresh token itself ran out. */
export async function refreshGitHubTokens(client: GitHubClient, credential: GitHubCredential): Promise<Result<GitHubCredential, ApiError>> {
	if (!credential.refreshToken) {
		return Err(ApiErr.credentialsRejected());
	}
	const tokens = await requestTokens(client, {grant_type: 'refresh_token', refresh_token: credential.refreshToken});
	return tokens.map((value) => ({
		...credential,
		accessToken: value.access_token,
		// GitHub hands out a new refresh token with every refresh, the old one spent.
		refreshToken: value.refresh_token ?? credential.refreshToken,
		expiresAt: expiresAt(value),
	}));
}

export function isExpiring(credential: GitHubCredential): boolean {
	return credential.expiresAt !== null && Date.parse(credential.expiresAt) - EXPIRY_MARGIN_MS < Date.now();
}

/**
 * Ends the person's authorization of the app at GitHub, as disconnecting does: every token made
 * under it stops working. Taken with the app's client as the password, which is how GitHub has an
 * app speak for itself here. One revoked already is gone all the same.
 */
export async function revokeGitHubGrant(client: GitHubClient, credential: GitHubCredential): Promise<Result<void, ApiError>> {
	const revoked = await httpRequest(
		`${GITHUB_API}/applications/${encodeURIComponent(client.clientId)}/grant`,
		{
			method: 'DELETE',
			headers: {...githubHeaders(null), authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`, 'content-type': 'application/json'},
			body: JSON.stringify({access_token: credential.accessToken}),
		},
		{timeoutMs: TIMEOUT_MS, allowStatus: (status) => (status >= 200 && status < 300) || status === 404},
	);
	return revoked.map(() => undefined).mapErr((error) => ApiErr.providerUnreachable(error));
}

/** Reads GitHub's answer to one of its API calls, for the tests of the parsers. */
export function parseGitHubUser(value: unknown): Result<z.infer<typeof userSchema>, ApiError> {
	return parseSchema(userSchema, value);
}
