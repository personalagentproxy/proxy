import {createHash, randomBytes} from 'node:crypto';

import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, type FetchError, httpRequest} from '@proxy/utils';

/**
 * Signing in to an MCP server, as the MCP spec asks of every client: OAuth 2.0 with PKCE against
 * the server's own authorization server, a client registered on the spot (Dynamic Client
 * Registration) with no secret, and refresh tokens for staying connected. Each connection keeps
 * the client it was made with, since refreshing needs it. Nothing has to be set up beforehand, so
 * a self-hosted Personal Agent Proxy connects the same way.
 */

/** An MCP server and the authorization server its tokens come from. */
export type McpServer = {
	// Its name in errors and logs: "Granola".
	name: string;
	// The server's MCP endpoint, also the resource its tokens are for.
	url: string;
	registerUrl: string;
	authorizeUrl: string;
	tokenUrl: string;
	scope: string;
	// What a tool failing means, from the text it failed with; else the server out of reach.
	toolError?: (text: string) => ApiError | null;
};

const TIMEOUT_MS = 15_000;

// Refreshed a minute early, so a token doesn't run out between the check and the call.
const EXPIRY_MARGIN_MS = 60_000;

/** What a connection to an MCP server stores, encrypted: the client it signed in with and its tokens. */
export const mcpCredentialSchema = z.object({
	clientId: z.string(),
	accessToken: z.string(),
	refreshToken: z.string().nullable(),
	expiresAt: z.string().nullable(),
});

export type McpCredential = z.infer<typeof mcpCredentialSchema>;

/** A finished sign-in: the credential, and the workspace it is for where the server names one, as Notion does. */
export type McpSignIn = {credential: McpCredential; workspaceName: string | null};

const registrationSchema = z.object({client_id: z.string().min(1)});

const tokensSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().optional(),
	expires_in: z.number().optional(),
	workspace_name: z.string().optional(),
});

/** A server turning a request down is the credential rejected; anything else is the server out of reach. */
export function mcpAuthError(error: FetchError): ApiError {
	if (error.kind === 'http' && error.status >= 400 && error.status < 500) {
		return ApiErr.credentialsRejected();
	}
	return ApiErr.providerUnreachable(error);
}

/** Registers Personal Agent Proxy with the server for one sign-in, returning back to `redirectUri`. */
export async function registerMcpClient(server: McpServer, redirectUri: string): Promise<Result<string, ApiError>> {
	const registration = await httpRequest(
		server.registerUrl,
		{
			method: 'POST',
			headers: {'content-type': 'application/json'},
			body: JSON.stringify({
				client_name: 'Personal Agent Proxy',
				redirect_uris: [redirectUri],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				token_endpoint_auth_method: 'none',
				scope: server.scope,
			}),
		},
		{schema: registrationSchema, timeoutMs: TIMEOUT_MS},
	);
	return registration.map(({client_id}) => client_id).mapErr((error) => ApiErr.providerUnreachable(error));
}

/** A PKCE verifier and the challenge the server is sent in its place. */
export function makePkce(): {verifier: string; challenge: string} {
	const verifier = randomBytes(32).toString('base64url');
	return {verifier, challenge: createHash('sha256').update(verifier).digest('base64url')};
}

/** The server's sign-in page, coming back to `redirectUri` with `state`. */
export function mcpAuthorizeUrl(server: McpServer, args: {clientId: string; redirectUri: string; state: string; challenge: string}): string {
	const url = new URL(server.authorizeUrl);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', args.clientId);
	url.searchParams.set('redirect_uri', args.redirectUri);
	url.searchParams.set('scope', server.scope);
	url.searchParams.set('state', args.state);
	url.searchParams.set('code_challenge', args.challenge);
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('resource', server.url);
	return url.toString();
}

async function requestTokens(server: McpServer, clientId: string, params: Record<string, string>, previousRefreshToken: string | null): Promise<Result<McpSignIn, ApiError>> {
	const tokens = await httpRequest(
		server.tokenUrl,
		{
			method: 'POST',
			headers: {'content-type': 'application/x-www-form-urlencoded'},
			body: new URLSearchParams({...params, client_id: clientId, resource: server.url}).toString(),
		},
		{schema: tokensSchema, timeoutMs: TIMEOUT_MS},
	);
	return tokens.mapErr(mcpAuthError).map((value) => ({
		credential: {
			clientId,
			accessToken: value.access_token,
			// A server may keep the refresh token as it is rather than send a new one.
			refreshToken: value.refresh_token ?? previousRefreshToken,
			expiresAt: value.expires_in === undefined ? null : new Date(Date.now() + value.expires_in * 1000).toISOString(),
		},
		workspaceName: value.workspace_name ?? null,
	}));
}

/** Trades the code the server sent back for the connection's first tokens. */
export function exchangeMcpCode(server: McpServer, args: {clientId: string; redirectUri: string; code: string; verifier: string}): Promise<Result<McpSignIn, ApiError>> {
	return requestTokens(server, args.clientId, {grant_type: 'authorization_code', code: args.code, redirect_uri: args.redirectUri, code_verifier: args.verifier}, null);
}

/** New tokens for a connection whose access token ran out; turned down once the server revoked it. */
export async function refreshMcpTokens(server: McpServer, credential: McpCredential): Promise<Result<McpCredential, ApiError>> {
	if (!credential.refreshToken) {
		return Err(ApiErr.credentialsRejected());
	}
	const refreshed = await requestTokens(server, credential.clientId, {grant_type: 'refresh_token', refresh_token: credential.refreshToken}, credential.refreshToken);
	return refreshed.map((signIn) => signIn.credential);
}

export function isExpiring(credential: McpCredential): boolean {
	return credential.expiresAt !== null && Date.parse(credential.expiresAt) - EXPIRY_MARGIN_MS < Date.now();
}
