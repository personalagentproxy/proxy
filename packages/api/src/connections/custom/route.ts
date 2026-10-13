import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {createConnection, getConnectionWithCredential, listConnections, updateConnectionCredential, updateConnectionTools} from '@proxy/db/connection';
import type {McpTool} from '@proxy/integrations';

import {queryParam} from '../../auth/session';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {encryptSecret} from '../../utils/secret-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {toConnectionResponse, type ConnectionResponse} from '../connection-response';
import {listMcpTools} from '../mcp/mcp-client';
import {mcpConnectRoutes} from '../mcp/mcp-connect';
import {listCustomTools, mcpAccount, readOnlyToolNames, type CustomCredential} from './custom-mcp';
import {discoverMcpServer, parseMcpServerUrl, probeMcpServer} from './mcp-discovery';

/**
 * Connecting a custom MCP server by its address. `POST /api/connections/mcp` asks the server for
 * its tools, with a token typed in or none: a server that answers is connected at once, with its
 * tools; one that asks for a sign-in gets one, started at `/api/connections/mcp/start?url=` and
 * finished as Granola's is. A new connection lets agents use the tools that only read; the rest
 * are turned on on the connection's page, which can also ask the server for its tools again.
 */

const connectBodySchema = z.object({url: z.string(), token: z.string().trim().optional()});

/** Connected, with the new connection, or the server asks for a sign-in, which the browser then starts. */
export type ConnectCustomMcpResponse = {kind: 'connected'; connection: ConnectionResponse} | {kind: 'signIn'};

// A connection of the server, made, or an existing one of the same address given the new credential and tools.
function saveConnection(request: AuthenticatedRequest, args: {url: URL; credential: CustomCredential; tools: McpTool[]}): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const account = mcpAccount(args.url);
		const encrypted = $(encryptSecret(JSON.stringify(args.credential)));
		const tools = JSON.stringify(args.tools);
		const orgId = $(await requireUserOrgId(request));
		const existing = $(await listConnections(orgId)).find((connection) => connection.integrationId === 'mcp' && connection.account === account);
		if (existing) {
			$(await updateConnectionCredential({connectionId: existing.id, credential: encrypted, tools}));
			return toConnectionResponse({...existing, tools});
		}
		const row = $(await createConnection({orgId, integrationId: 'mcp', account, credential: encrypted, defaults: readOnlyToolNames(args.tools), tools}));
		return toConnectionResponse(row);
	});
}

/** `POST /api/connections/mcp` with `{url, token?}`: connects the server, or says it asks for a sign-in. */
export function handleConnectCustomMcpRoute(request: AuthenticatedRequest): Promise<Result<ConnectCustomMcpResponse, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(connectBodySchema, request.body));
		const url = $(parseMcpServerUrl(body.url));
		const token = body.token || null;
		const probe = $(await probeMcpServer(url, token));
		if (probe.kind === 'signIn') {
			// Found now, so the form hears why a sign-in can't start rather than the catalog.
			$(await discoverMcpServer(url));
			return {kind: 'signIn' as const};
		}
		const credential: CustomCredential = token === null ? {auth: 'none', url: url.toString()} : {auth: 'token', url: url.toString(), token};
		return {kind: 'connected' as const, connection: $(await saveConnection(request, {url, credential, tools: probe.tools}))};
	});
}

export const {handleStart: handleStartCustomMcpRoute, handleCallback: handleCustomMcpCallbackRoute} = mcpConnectRoutes({
	integrationId: 'mcp',
	server: {
		name: 'MCP server',
		resolve: async (request) => {
			const url = parseMcpServerUrl(queryParam(request, 'url') ?? '');
			if (url.isErr()) {
				return Err(url.error);
			}
			return discoverMcpServer(url.value);
		},
	},
	// Signed in, the server is asked for its tools with the new token, and the connection keeps its
	// endpoints beside the tokens, for refreshing them.
	connection: async (signIn, server) => {
		const {name, url, registerUrl, authorizeUrl, tokenUrl, scope, handshake} = server;
		const endpoints = {name, url, registerUrl, authorizeUrl, tokenUrl, scope, ...(handshake ? {handshake} : {})};
		return (await listMcpTools(server, signIn.credential.accessToken)).map((tools) => ({
			account: mcpAccount(new URL(url)),
			credential: {auth: 'oauth', url, server: endpoints, ...signIn.credential} satisfies CustomCredential,
			defaults: readOnlyToolNames(tools),
			tools,
		}));
	},
});

/** `POST /api/connections/:connectionId/tools`: asks the server for its tools again and keeps the new list. */
export function handleRefreshCustomMcpToolsRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const connectionId = request.params.connectionId ?? '';
		const row = $(requirePresent($(await getConnectionWithCredential(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		if (row.integrationId !== 'mcp') {
			return $(Err(ApiErr.validationError('Only a custom MCP server has tools to ask for again')));
		}
		const tools = $(await listCustomTools(row));
		const stored = JSON.stringify(tools);
		$(await updateConnectionTools({connectionId, tools: stored}));
		return toConnectionResponse({...row, tools: stored});
	});
}
