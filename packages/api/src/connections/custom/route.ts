import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getConnectionWithCredential, updateConnectionTools} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {sendResult} from '../../server/response';
import {requireUserOrgId} from '../../utils/user-org';
import {toConnectionResponse, type ConnectionResponse} from '../connection-response';
import {listMcpTools} from '../mcp/mcp-client';
import {mcpSignInRoutes, returnToSchema, saveMcpConnection} from '../mcp/mcp-connect';
import {mcpEndpoints} from '../mcp/mcp-oauth';
import {listCustomTools, mcpAccount, readOnlyToolNames, type CustomCredential} from './custom-mcp';
import {discoverMcpServer, parseMcpServerUrl, probeMcpServer} from './mcp-discovery';

/**
 * Connecting a custom MCP server by its address. `POST /api/connections/mcp` asks the server for
 * its tools, with a token typed in or none: a server that answers is connected at once, with its
 * tools; for one that asks for a sign-in, the sign-in is begun here, where the address came in
 * with the browser's origin checked, and the answer is the server's sign-in page for the browser
 * to go to, which comes back to the callback as Granola's does. A new connection lets agents use
 * the tools that only read; the rest are turned on on the connection's page, which can also ask
 * the server for its tools again.
 */

const connectBodySchema = z.object({url: z.string(), token: z.string().trim().optional(), returnTo: returnToSchema.optional()});

/** Connected, with the new connection, or the server asks for a sign-in, begun, at the page the browser goes to. */
export type ConnectCustomMcpResponse = {kind: 'connected'; connection: ConnectionResponse} | {kind: 'signIn'; url: string};

const {beginSignIn, handleCallback: handleCustomMcpCallbackRoute} = mcpSignInRoutes({
	integrationId: 'mcp',
	name: 'MCP server',
	server: null,
	// Signed in, the server is asked for its tools with the new token, and the connection keeps its
	// endpoints beside the tokens, for refreshing them.
	connection: async (signIn, server) =>
		(await listMcpTools(server, signIn.credential.accessToken)).map((tools) => ({
			account: mcpAccount(new URL(server.url)),
			credential: {auth: 'oauth', url: server.url, server: mcpEndpoints(server), ...signIn.credential} satisfies CustomCredential,
			defaults: readOnlyToolNames(tools),
			tools,
		})),
});

export {handleCustomMcpCallbackRoute};

function connectCustomMcp(request: AuthenticatedRequest, res: Response): Promise<Result<ConnectCustomMcpResponse, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(connectBodySchema, request.body));
		const url = $(await parseMcpServerUrl(body.url));
		const token = body.token || null;
		const probe = $(await probeMcpServer(url, token));
		if (probe.kind === 'signIn') {
			const server = $(await discoverMcpServer(url));
			return {kind: 'signIn' as const, url: $(await beginSignIn(res, {userId: request.user.userId, server, returnTo: body.returnTo}))};
		}
		const credential: CustomCredential = token === null ? {auth: 'none', url: url.toString()} : {auth: 'token', url: url.toString(), token};
		const orgId = $(await requireUserOrgId(request));
		const row = $(await saveMcpConnection(orgId, 'mcp', {account: mcpAccount(url), credential, defaults: readOnlyToolNames(probe.tools), tools: probe.tools}));
		return {kind: 'connected' as const, connection: toConnectionResponse(row)};
	});
}

/** `POST /api/connections/mcp` with `{url, token?, returnTo?}`: connects the server, or begins the sign-in it asks for. */
export async function handleConnectCustomMcpRoute(request: AuthenticatedRequest, res: Response): Promise<void> {
	sendResult(res, await connectCustomMcp(request, res));
}

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
		$(await updateConnectionTools({connectionId, tools: stored, actions: tools.map((tool) => tool.name)}));
		return toConnectionResponse({...row, tools: stored});
	});
}
