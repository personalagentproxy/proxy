import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getConnectionWithCredential, updateConnectionTools} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {sendResult} from '../../server/response';
import {requireUserOrgId} from '../../utils/user-org';
import {builtInForHost} from '../built-in-mcp';
import {toConnectionResponse, type ConnectionResponse} from '../connection-response';
import {connectionNameSchema, returnToSchema, saveConnection, signInFlow, type SignInRequest} from '../connect-flow';
import {listMcpTools} from '../mcp/mcp-client';
import {keyInAddress} from '../mcp/built-in';
import {beginBuiltInSignIn, connectWithKey, startMcpSignIn} from '../mcp/mcp-connect';
import {exchangeMcpCode, mcpEndpoints, mcpEndpointsSchema} from '../mcp/mcp-oauth';
import {listCustomTools, mcpAccount, readOnlyToolNames, type CustomCredential} from './custom-mcp';
import {discoverMcpServer, parseMcpServerUrl, probeMcpServer} from './mcp-discovery';

/**
 * Connecting a custom MCP server by its address, under a name the person gives it, since a server
 * says nothing about itself that would do. `POST /api/connections/mcp` asks the server for
 * its tools, with a token typed in or none (sent as a bearer token, or as written when it has its
 * scheme in front, "Basic …"): a server that answers is connected at once, with its tools; for one
 * that asks for a sign-in, the sign-in is begun here, where the address came in
 * with the browser's origin checked, and the answer is the server's sign-in page for the browser
 * to go to, which comes back to the callback as Granola's does. A new connection lets agents use
 * the tools that only read; the rest are turned on on the connection's page, which can also ask
 * the server for its tools again. A server Personal Agent Proxy has an integration of its own for
 * is connected as that integration instead: with the token typed in, or the key in the address, as
 * its API key, where it takes one, else the answer is its sign-in, as signing in to it from the
 * catalog begins, which comes back to its callback; a token for one that takes no key is refused.
 */

// A token is sent as a header, where a line break has no place.
const connectBodySchema = z.object({
	name: connectionNameSchema,
	url: z.string(),
	token: z
		.string()
		.trim()
		.regex(/^[^\r\n]*$/, 'The token can’t have line breaks')
		.optional(),
	returnTo: returnToSchema.optional(),
});

/** Connected, with the new connection, or the server asks for a sign-in, begun, at the page the browser goes to. */
export type ConnectCustomMcpResponse = {kind: 'connected'; connection: ConnectionResponse} | {kind: 'signIn'; url: string};

const {beginSignIn, handleCallback: handleCustomMcpCallbackRoute} = signInFlow({
	integrationId: 'mcp',
	name: 'MCP server',
	// The server found from the address and the name the person gave the connection, beside the
	// client registered for the sign-in.
	keptSchema: z.object({clientId: z.string(), server: mcpEndpointsSchema, name: z.string()}),
	// Signed in, the server is asked for its tools with the new token, and the connection keeps its
	// endpoints beside the tokens, for refreshing them.
	finish: ({redirectUri, code, verifier, kept}) =>
		Do(async ($) => {
			const {server, name} = kept;
			const tokens = $(await exchangeMcpCode(server, {clientId: kept.clientId, redirectUri, code, verifier}));
			const tools = $(await listMcpTools(server, tokens.accessToken));
			const credential: CustomCredential = {auth: 'oauth', url: server.url, server, ...tokens};
			return {account: mcpAccount(new URL(server.url)), credential, defaults: readOnlyToolNames(tools), tools, name};
		}),
});

export {handleCustomMcpCallbackRoute};

function connectCustomMcp(request: AuthenticatedRequest, res: Response): Promise<Result<ConnectCustomMcpResponse, ApiError>> {
	return Do(async ($) => {
		const body = $(parseSchema(connectBodySchema, request.body));
		const url = $(await parseMcpServerUrl(body.url));
		const token = body.token || null;
		// A server of an integration built in is connected as that integration: with the token, or
		// the key in the address, as its API key, where it takes one, else signed in to as its
		// catalog's entry is. A token for one that only signs in is refused rather than dropped.
		const builtIn = builtInForHost(url.host);
		const key = builtIn && (token ?? keyInAddress(builtIn, url));
		if (builtIn && key && builtIn.apiKey) {
			const orgId = $(await requireUserOrgId(request));
			const row = $(await connectWithKey(builtIn, orgId, {name: body.name, key, connectionId: null}));
			return {kind: 'connected' as const, connection: toConnectionResponse(row, [])};
		}
		if (builtIn && token) {
			return $(Err(ApiErr.validationError(`${builtIn.server.name} is connected by signing in to it, so leave the token out`)));
		}
		if (builtIn) {
			return {kind: 'signIn' as const, url: $(await beginBuiltInSignIn(builtIn, res, {userId: request.user.userId, returnTo: body.returnTo, name: body.name}))};
		}
		const probe = $(await probeMcpServer(url, token));
		if (probe.kind === 'signIn') {
			const server = $(await discoverMcpServer(url));
			const start = (signIn: SignInRequest) => startMcpSignIn(server, signIn, {server: mcpEndpoints(server), name: body.name});
			return {kind: 'signIn' as const, url: $(await beginSignIn(res, {userId: request.user.userId, returnTo: body.returnTo, account: null, start}))};
		}
		const credential: CustomCredential = token === null ? {auth: 'none', url: url.toString()} : {auth: 'token', url: url.toString(), token};
		const orgId = $(await requireUserOrgId(request));
		const {row} = $(await saveConnection(orgId, 'mcp', {account: mcpAccount(url), credential, defaults: readOnlyToolNames(probe.tools), tools: probe.tools, name: body.name}));
		return {kind: 'connected' as const, connection: toConnectionResponse(row, [])};
	});
}

/** `POST /api/connections/mcp` with `{name, url, token?, returnTo?}`: connects the server, or begins the sign-in it asks for. */
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
		return toConnectionResponse({...row, tools: stored}, []);
	});
}
