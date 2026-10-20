import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError} from '@proxy/utils';

import {callWithToken, type TokenRefresher} from '../token-session';
import {callMcpTool} from './mcp-client';
import {isExpiring, mcpCredentialSchema, refreshMcpTokens, type McpServer} from './mcp-oauth';

type StoredConnection = {id: string; credential: string | null};

/** What a connection made with an API key stores, encrypted, as Exa's and Parallel's may be: the key, sent as the bearer token. */
export const mcpKeyCredentialSchema = z.object({auth: z.literal('key'), key: z.string()});

export type McpKeyCredential = z.infer<typeof mcpKeyCredentialSchema>;

// An API key; or the tokens, and whatever else the credential holds beside them, as a custom
// server's address and endpoints, kept as it is when the tokens are replaced.
const storedCredentialSchema = z.union([mcpKeyCredentialSchema, mcpCredentialSchema.loose()]);

type StoredCredential = z.infer<typeof storedCredentialSchema>;

function isKey(credential: StoredCredential): credential is McpKeyCredential {
	return credential.auth === 'key';
}

// A key is sent as it is and never refreshed: one the server turns down has to be replaced.
function mcpRefresher(server: McpServer): TokenRefresher<StoredCredential> {
	return {
		name: server.name,
		schema: storedCredentialSchema,
		isExpiring: (credential) => !isKey(credential) && isExpiring(credential),
		refresh: async (credential) => {
			if (isKey(credential)) {
				return Err(ApiErr.credentialsRejected());
			}
			return (await refreshMcpTokens(server, credential)).map((tokens) => ({...credential, ...tokens}));
		},
	};
}

/**
 * Runs `use` with a connection's access token, or its API key: a token refreshed first when it is
 * running out, and once more when the server turns it down anyway. A connection the server won't
 * refresh any more, or whose key it turns down, is `credentials_rejected`, and has to be signed in
 * to again or given a new key.
 */
export function withMcpToken<T>(server: McpServer, connection: StoredConnection, use: (accessToken: string) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return callWithToken(mcpRefresher(server), connection, (credential) => use(isKey(credential) ? credential.key : credential.accessToken));
}

/** Calls one of a server's tools with a connection's token, refreshed as `withMcpToken` does. */
export function callMcpToolFor(server: McpServer, connection: StoredConnection, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return withMcpToken(server, connection, (accessToken) => callMcpTool(server, accessToken, name, args));
}
