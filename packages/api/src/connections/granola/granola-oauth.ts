import {createHash, randomBytes} from 'node:crypto';

import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, type FetchError, httpRequest} from '@proxy/utils';

/**
 * Signing in to Granola, as its MCP server asks of every client: OAuth 2.0 with PKCE against
 * Granola's own authorization server, a client registered on the spot (Dynamic Client
 * Registration) with no secret, and refresh tokens for staying connected. Each connection keeps
 * the client it was made with, since refreshing needs it.
 */

const AUTH_BASE = 'https://mcp-auth.granola.ai';
export const GRANOLA_MCP_URL = 'https://mcp.granola.ai/mcp';
const SCOPE = 'openid profile email offline_access';
const TIMEOUT_MS = 15_000;

// Refreshed a minute early, so a token doesn't run out between the check and the call.
const EXPIRY_MARGIN_MS = 60_000;

/** What a Granola connection stores, encrypted: the client it signed in with and its tokens. */
export const granolaCredentialSchema = z.object({
	clientId: z.string(),
	accessToken: z.string(),
	refreshToken: z.string().nullable(),
	expiresAt: z.string().nullable(),
});

export type GranolaCredential = z.infer<typeof granolaCredentialSchema>;

const registrationSchema = z.object({client_id: z.string().min(1)});

const tokensSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().optional(),
	expires_in: z.number().optional(),
});

const userInfoSchema = z.object({sub: z.string(), email: z.string().optional(), name: z.string().optional()});

function granolaError(error: FetchError): ApiError {
	if (error.kind === 'http' && error.status >= 400 && error.status < 500) {
		return ApiErr.credentialsRejected();
	}
	return ApiErr.providerUnreachable(error);
}

/** Registers Personal Agent Proxy with Granola for one sign-in, returning back to `redirectUri`. */
export async function registerGranolaClient(redirectUri: string): Promise<Result<string, ApiError>> {
	const registration = await httpRequest(
		`${AUTH_BASE}/oauth2/register`,
		{
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({
				client_name: 'Personal Agent Proxy',
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
				scope: SCOPE,
			}),
		},
		{schema: registrationSchema, timeoutMs: TIMEOUT_MS},
	);
	return registration.map(({client_id}) => client_id).mapErr((error) => ApiErr.providerUnreachable(error));
}

/** A PKCE verifier and the challenge Granola is sent in its place. */
export function makePkce(): {verifier: string; challenge: string} {
	const verifier = randomBytes(32).toString('base64url');
	return {verifier, challenge: createHash('sha256').update(verifier).digest('base64url')};
}

/** Granola's sign-in page, for the MCP server, coming back to `redirectUri` with `state`. */
export function granolaAuthorizeUrl(args: {clientId: string; redirectUri: string; state: string; challenge: string}): string {
	const url = new URL(`${AUTH_BASE}/oauth2/authorize`);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', args.clientId);
	url.searchParams.set('redirect_uri', args.redirectUri);
	url.searchParams.set('scope', SCOPE);
	url.searchParams.set('state', args.state);
	url.searchParams.set('code_challenge', args.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('resource', GRANOLA_MCP_URL);
	return url.toString();
}

async function requestTokens(clientId: string, params: Record<string, string>, previousRefreshToken: string | null): Promise<Result<GranolaCredential, ApiError>> {
	const tokens = await httpRequest(
		`${AUTH_BASE}/oauth2/token`,
		{
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({...params, client_id: clientId, resource: GRANOLA_MCP_URL}).toString(),
		},
		{schema: tokensSchema, timeoutMs: TIMEOUT_MS},
	);
	return tokens.mapErr(granolaError).map((value) => ({
		clientId,
		accessToken: value.access_token,
		// Granola may keep the refresh token as it is rather than send a new one.
		refreshToken: value.refresh_token ?? previousRefreshToken,
		expiresAt: value.expires_in === undefined ? null : new Date(Date.now() + value.expires_in * 1000).toISOString(),
	}));
}

/** Trades the code Granola sent back for the connection's first tokens. */
export function exchangeGranolaCode(args: {clientId: string; redirectUri: string; code: string; verifier: string}): Promise<Result<GranolaCredential, ApiError>> {
	return requestTokens(args.clientId, {grant_type: 'authorization_code', code: args.code, redirect_uri: args.redirectUri, code_verifier: args.verifier}, null);
}

/** New tokens for a connection whose access token ran out; turned down once Granola revoked it. */
export function refreshGranolaTokens(credential: GranolaCredential): Promise<Result<GranolaCredential, ApiError>> {
	if (!credential.refreshToken) {
		return Promise.resolve(Err(ApiErr.credentialsRejected()));
	}
	return requestTokens(credential.clientId, {grant_type: 'refresh_token', refresh_token: credential.refreshToken}, credential.refreshToken);
}

export function isExpiring(credential: GranolaCredential): boolean {
	return credential.expiresAt !== null && Date.parse(credential.expiresAt) - EXPIRY_MARGIN_MS < Date.now();
}

/** The Granola account a token belongs to: its email, else its name, else Granola's id for it. */
export async function getGranolaAccount(accessToken: string): Promise<Result<string, ApiError>> {
	const info = await httpRequest(`${AUTH_BASE}/oauth2/userinfo`, {headers: {authorization: `Bearer ${accessToken}`}}, {schema: userInfoSchema, timeoutMs: TIMEOUT_MS});
	if (info.isErr()) {
		return Err(granolaError(info.error));
	}
	return Ok(info.value.email?.toLowerCase() ?? info.value.name ?? info.value.sub);
}
