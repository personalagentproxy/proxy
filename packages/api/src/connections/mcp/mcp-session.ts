import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError} from '@proxy/utils';

import {callWithToken, type TokenRefresher} from '../token-session';
import {callMcpTool} from './mcp-client';
import {storedBuiltInCredentialSchema, type BuiltInCredential, type OAuthCredential} from './mcp-credential';
import {isExpiring, refreshMcpTokens, type McpServer} from './mcp-oauth';

type StoredConnection = {id: string; credential: string | null};

// A credential the session can send: a token or key, or a sign-in's, with whatever else it holds
// beside them, as a custom server's address and endpoints, kept as it is when the tokens are replaced.
type Sendable = Extract<BuiltInCredential, {auth: 'token'}> | OAuthCredential;

function isSignIn<C extends Sendable>(credential: C): credential is C & OAuthCredential {
	return credential.auth === 'oauth';
}

// A token or key is sent as it is and never refreshed: one the server turns down has to be replaced.
function mcpRefresher<C extends Sendable>(server: McpServer, schema: z.ZodType<C>): TokenRefresher<C> {
	return {
		name: server.name,
		schema,
		isExpiring: (credential) => isSignIn(credential) && isExpiring(credential),
		refresh: async (credential) => {
			if (!isSignIn(credential)) {
				return Err(ApiErr.credentialsRejected());
			}
			return (await refreshMcpTokens(server, credential)).map((tokens): C => ({...credential, ...tokens}));
		},
	};
}

// What is sent: the token or key, or the sign-in's access token.
function sent(credential: Sendable): string {
	if (credential.auth === 'oauth') {
		return credential.accessToken;
	}
	return credential.token;
}

/**
 * Runs `use` with a custom server's sign-in, read with `schema`, which keeps its address and
 * endpoints beside the tokens when they are refreshed, as `withMcpToken` does (`custom/custom-mcp.ts`).
 */
export function withMcpSignIn<T, C extends Sendable>(
	server: McpServer,
	connection: StoredConnection,
	schema: z.ZodType<C>,
	use: (accessToken: string) => Promise<Result<T, ApiError>>,
): Promise<Result<T, ApiError>> {
	return callWithToken(mcpRefresher(server, schema), connection, (credential) => use(sent(credential)));
}

/**
 * Runs `use` with a built-in integration's connection's access token, or its key: a sign-in's
 * refreshed first when it is running out, and once more when the server turns it down anyway. A
 * connection the server won't refresh any more, or whose key it turns down, is
 * `credentials_rejected`, and has to be signed in to again or given a new key.
 */
export function withMcpToken<T>(server: McpServer, connection: StoredConnection, use: (accessToken: string) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return withMcpSignIn(server, connection, storedBuiltInCredentialSchema, use);
}

/** Calls one of a server's tools with a connection's token, refreshed as `withMcpToken` does. */
export function callMcpToolFor(server: McpServer, connection: StoredConnection, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return withMcpToken(server, connection, (accessToken) => callMcpTool(server, accessToken, name, args));
}
