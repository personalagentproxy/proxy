import {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {mcpToolReadsOnly, type McpTool} from '@proxy/integrations';

import {readStoredJson} from '../../utils/stored-json';
import {callMcpTool, listMcpTools} from '../mcp/mcp-client';
import {noAuthSchema, oauthAuthSchema, tokenAuthSchema} from '../mcp/mcp-credential';
import {mcpEndpointsSchema, type McpEndpoint, type McpServer} from '../mcp/mcp-oauth';
import {withMcpCredential} from '../mcp/mcp-session';

/**
 * A custom MCP server, by its address: connected with no sign-in where the server asks for none,
 * with a token typed in, or by signing in to it as Granola is. Its tools are called as they are,
 * one `tools/call` each, in a session of the server's, and what the tool answers is passed on to
 * the agent as the server wrote it (`mcp-discovery.ts` finds out how a server is signed in to).
 */

// Signed in: the server's endpoints beside the tokens, so refreshing needs nothing else.
const customSignInSchema = oauthAuthSchema.extend({url: z.string(), server: mcpEndpointsSchema});

/**
 * What a custom MCP connection stores, encrypted: an MCP credential (`mcp-credential.ts`) with the
 * server's address beside it.
 */
export const customCredentialSchema = z.discriminatedUnion('auth', [noAuthSchema.extend({url: z.string()}), tokenAuthSchema.extend({url: z.string()}), customSignInSchema]);

export type CustomCredential = z.infer<typeof customCredentialSchema>;

/** What a connection shows as its account: the address without its scheme or query, "mcp.example.com/mcp". */
export function mcpAccount(url: URL): string {
	return `${url.host}${url.pathname.replace(/\/$/, '')}`;
}

// A tool that fails says why in words for the agent, which is a bad request rather than the server
// being out of reach.
function customToolError(text: string): ApiError {
	return ApiErr.validationError(text.trim() || 'The tool failed without saying why');
}

/** The server at an address, as far as calling its tools goes. */
export function customEndpoint(url: string): McpEndpoint {
	return {name: new URL(url).host, url, handshake: true, toolError: customToolError};
}

function customServer(credential: Extract<CustomCredential, {auth: 'oauth'}>): McpServer {
	return {...customEndpoint(credential.url), ...credential.server};
}

type StoredConnection = {id: string; credential: string | null};

/** What a custom MCP connection signs in to its server with, decrypted. */
export function readCustomCredential(connection: StoredConnection): Result<CustomCredential, ApiError> {
	return Do<CustomCredential, ApiError>(($) => {
		const stored = $(requirePresent(connection.credential, ApiErr.internalError(new Error('Custom MCP connection without a credential'))));
		return $(readStoredJson(stored, customCredentialSchema));
	});
}

// Runs `use` against the server with whatever the connection signs in with: nothing, the token
// typed in, or the access token, refreshed as it runs out.
function withCustomServer<T>(connection: StoredConnection, use: (server: McpEndpoint, accessToken: string | null) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const credential = $(readCustomCredential(connection));
		if (credential.auth === 'none') {
			return $(await use(customEndpoint(credential.url), null));
		}
		if (credential.auth === 'token') {
			return $(await use(customEndpoint(credential.url), credential.token));
		}
		const server = customServer(credential);
		return $(await withMcpCredential(server, connection, customSignInSchema, (accessToken) => use(server, accessToken)));
	});
}

/** Calls one of the server's tools for a connection, what the tool answered as text. */
export function callCustomTool(connection: StoredConnection, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return withCustomServer(connection, (server, accessToken) => callMcpTool(server, accessToken, name, args));
}

/** The server's tools as it lists them now, for a connection. */
export function listCustomTools(connection: StoredConnection): Promise<Result<McpTool[], ApiError>> {
	return withCustomServer(connection, (server, accessToken) => listMcpTools(server, accessToken));
}

/** The actions a new custom connection gives agents from the start: the tools that only read. */
export function readOnlyToolNames(tools: McpTool[]): string[] {
	return tools.filter(mcpToolReadsOnly).map((tool) => tool.name);
}
