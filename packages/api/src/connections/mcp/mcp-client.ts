import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {mcpToolSchema, type McpTool} from '@proxy/integrations';

import {checkedRequest} from '../../utils/checked-request';
import type {McpEndpoint} from './mcp-oauth';

/**
 * An MCP server, called one tool at a time over Streamable HTTP, every request through
 * `checkedRequest`, since a custom server is wherever its address says. Granola's, Notion's and
 * Linear's servers keep no session, so each call is a single JSON-RPC `tools/call` with the access
 * token, answered as JSON or as a one-event stream. A server that may keep one, as any custom
 * server may (`handshake`), is initialized first, as the spec asks, the call sent with the session
 * it answers with, and the session ended after.
 */

const TIMEOUT_MS = 30_000;

// The newest version this client speaks; a server may answer with an older one, which is then used.
const PROTOCOL_VERSION = '2025-06-18';

// How many pages of tools a server is asked for.
const MAX_TOOL_PAGES = 20;

const CLIENT_INFO = {name: 'personal-agent-proxy', title: 'Personal Agent Proxy', version: '1.0.0'};

const jsonRpcErrorSchema = z.object({message: z.string()});

const toolResponseSchema = z.object({
	result: z
		.object({
			content: z.array(z.object({type: z.string(), text: z.string().optional()})),
			isError: z.boolean().optional(),
		})
		.optional(),
	error: jsonRpcErrorSchema.optional(),
});

const initializeResponseSchema = z.object({
	result: z.object({protocolVersion: z.string().optional()}).optional(),
	error: jsonRpcErrorSchema.optional(),
});

// Tools the server lists that don't fit the spec, such as one without a name, are left out.
const toolsListResponseSchema = z.object({
	result: z.object({tools: z.array(z.unknown()), nextCursor: z.string().optional()}).optional(),
	error: jsonRpcErrorSchema.optional(),
});

// The session a server keeps between calls, when it keeps one, and the protocol version it chose.
type McpSession = {sessionId: string | null; protocolVersion: string};

const NO_SESSION: McpSession = {sessionId: null, protocolVersion: PROTOCOL_VERSION};

// The last `data:` line of an event stream, or the body as it is when it is plain JSON.
function jsonRpcBody(body: string): string {
	const events = body
		.split('\n')
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice('data:'.length).trim());
	return events.at(-1) ?? body;
}

type Posted = {json: unknown; sessionId: string | null};

// One JSON-RPC message to the server, its answer parsed, or nothing for a notification. A token the
// server turns down is `credentials_rejected`, so the caller can refresh it.
function post(server: McpEndpoint, accessToken: string | null, session: McpSession | null, message: Record<string, unknown>): Promise<Result<Posted, ApiError>> {
	return Do(async ($) => {
		const headers: Record<string, string> = {'content-type': 'application/json', accept: 'application/json, text/event-stream'};
		if (accessToken !== null) {
			headers.authorization = `Bearer ${accessToken}`;
		}
		if (session) {
			headers['mcp-protocol-version'] = session.protocolVersion;
		}
		if (session?.sessionId) {
			headers['mcp-session-id'] = session.sessionId;
		}
		const response = await checkedRequest(server.url, {method: 'POST', headers, body: JSON.stringify({jsonrpc: '2.0', ...message})}, {parse: 'response', timeoutMs: TIMEOUT_MS});
		if (response.isErr() && response.error.kind === 'http' && (response.error.status === 401 || response.error.status === 403)) {
			return $(Err(ApiErr.credentialsRejected()));
		}

		const answer = $(response.mapErr((error) => ApiErr.providerUnreachable(error)));
		const body = $((await Result.wrapAsync(() => answer.text())).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		const sessionId = answer.headers.get('mcp-session-id');
		if (body.trim() === '') {
			return {json: null, sessionId};
		}
		const json = $(Result.wrap((): unknown => JSON.parse(jsonRpcBody(body))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		return {json, sessionId};
	});
}

// A request's answer, read with `schema`: a JSON-RPC error, or no result, is the server out of reach.
function readResult<T extends {result?: unknown; error?: {message: string}}>(server: McpEndpoint, what: string, schema: z.ZodType<T>, json: unknown): Result<NonNullable<T['result']>, ApiError> {
	return Do<NonNullable<T['result']>, ApiError>(($) => {
		const message = $(parseSchema(schema, json).mapErr((error) => ApiErr.providerUnreachable(error)));
		if (message.error || message.result === undefined || message.result === null) {
			return $(Err(ApiErr.providerUnreachable(new Error(`${server.name}'s ${what} failed: ${message.error?.message ?? 'no result'}`))));
		}
		return message.result as NonNullable<T['result']>;
	});
}

// Initializes a session, as the spec asks before anything else, and tells the server it is ready;
// only for a server that may keep one. The rest are called as they are.
function openSession(server: McpEndpoint, accessToken: string | null): Promise<Result<McpSession, ApiError>> {
	return Do(async ($) => {
		if (!server.handshake) {
			return NO_SESSION;
		}
		const initialized = $(await post(server, accessToken, null, {id: 1, method: 'initialize', params: {protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO}}));
		const result = $(readResult(server, 'initialize', initializeResponseSchema, initialized.json));
		const session: McpSession = {sessionId: initialized.sessionId, protocolVersion: result.protocolVersion ?? PROTOCOL_VERSION};
		// A server that turns the notification down still answers requests, so its answer is not read.
		await post(server, accessToken, session, {method: 'notifications/initialized'});
		return session;
	});
}

// Ends a session the server keeps; one that doesn't let sessions be ended answers 405, which is fine.
async function closeSession(server: McpEndpoint, accessToken: string | null, session: McpSession): Promise<void> {
	if (!session.sessionId) {
		return;
	}
	const headers: Record<string, string> = {'mcp-session-id': session.sessionId, 'mcp-protocol-version': session.protocolVersion};
	if (accessToken !== null) {
		headers.authorization = `Bearer ${accessToken}`;
	}
	await checkedRequest(server.url, {method: 'DELETE', headers}, {timeoutMs: TIMEOUT_MS});
}

// Runs `use` in a session of the server's, opened and closed around it where the server keeps one.
function inSession<T>(server: McpEndpoint, accessToken: string | null, use: (session: McpSession) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const session = $(await openSession(server, accessToken));
		const result = await use(session);
		await closeSession(server, accessToken, session);
		return $(result);
	});
}

/**
 * Calls one of a server's tools, its answer's text. A token the server turns down is
 * `credentials_rejected`, so the caller can refresh it; a tool failing is what the server's
 * `toolError` makes of it, else the server out of reach. No token is sent for a server that takes
 * none (`null`).
 */
export function callMcpTool(server: McpEndpoint, accessToken: string | null, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return inSession(server, accessToken, (session) =>
		Do(async ($) => {
			const posted = $(await post(server, accessToken, server.handshake ? session : null, {id: 1, method: 'tools/call', params: {name, arguments: args}}));
			const result = $(readResult(server, name, toolResponseSchema, posted.json));
			const text = result.content.map((block) => block.text ?? '').join('\n');
			if (result.isError) {
				return $(Err(server.toolError?.(text) ?? ApiErr.providerUnreachable(new Error(`${server.name}'s ${name} failed: ${text}`))));
			}
			return text;
		}),
	);
}

/** The tools a server lists, every page of them, as the server describes them. */
export function listMcpTools(server: McpEndpoint, accessToken: string | null): Promise<Result<McpTool[], ApiError>> {
	return inSession(server, accessToken, (session) =>
		Do(async ($) => {
			const tools: McpTool[] = [];
			let cursor: string | undefined;
			for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
				const posted = $(await post(server, accessToken, session, {id: page + 1, method: 'tools/list', params: cursor === undefined ? {} : {cursor}}));
				const result = $(readResult(server, 'tools/list', toolsListResponseSchema, posted.json));
				tools.push(...result.tools.flatMap((tool) => mcpToolSchema.safeParse(tool).data ?? []));
				cursor = result.nextCursor;
				if (cursor === undefined || cursor === '') {
					return tools;
				}
			}
			return tools;
		}),
	);
}
