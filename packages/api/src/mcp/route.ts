import {createHash, randomUUID} from 'node:crypto';
import type {IncomingHttpHeaders} from 'node:http';

import type {Request, Response} from 'express';
import {z} from 'zod';

import type {SignedInAgent} from '@proxy/db/agent';

import {authenticateBearer, wwwAuthenticate} from '../oauth/authenticate';
import {requireAppUrl} from '../oauth/oauth-config';
import {log, serializeError} from '../observability/log';
import {isPreTaskCall} from './pre-task-clients';
import {callMcpTool, MCP_TOOLS, serverInstructions} from './tools';

/**
 * The MCP server at `/mcp`: Streamable HTTP, kept on no instance, so any instance answers any
 * request. Each POST carries JSON-RPC and gets JSON back. Every request is signed in with an OAuth
 * access token for an agent.
 *
 * The session id `initialize` hands out ends in the version of the tool list, the only thing a
 * session holds. When a client calls a tool on a session from before the list changed, as after a
 * deploy, the answer comes as a stream that first says the list changed, so the client fetches it
 * again. That is the only push; there is no stream to GET.
 */

// Newest first; a client asking for one we don't know gets the newest.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = {name: 'personal-agent-proxy', title: 'Personal Agent Proxy', version: '1.0.0'};

const TOOLS_VERSION = createHash('sha256').update(JSON.stringify(MCP_TOOLS)).digest('hex').slice(0, 16);

const LIST_CHANGED = {jsonrpc: '2.0', method: 'notifications/tools/list_changed'};

type JsonRpcId = string | number;

type JsonRpcResponse = {jsonrpc: '2.0'; id: JsonRpcId | null} & ({result: Record<string, unknown>} | {error: {code: number; message: string}});

const messageSchema = z.object({
	jsonrpc: z.literal('2.0'),
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string().optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});

const callParamsSchema = z.object({name: z.string(), arguments: z.record(z.string(), z.unknown()).optional()});

function failure(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
	return {jsonrpc: '2.0', id, error: {code, message}};
}

async function initialize(signedIn: SignedInAgent, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
	const instructions = await serverInstructions(signedIn);
	return {
		protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
		capabilities: {tools: {listChanged: true}},
		serverInfo: SERVER_INFO,
		...(instructions.isOk() ? {instructions: instructions.value} : {}),
	};
}

// The answer to one message: null for a notification, or for a client's answer to a request,
// which this server never makes.
async function answer(signedIn: SignedInAgent, message: unknown, headers: IncomingHttpHeaders): Promise<JsonRpcResponse | null> {
	const parsed = messageSchema.safeParse(message);
	if (!parsed.success) {
		return failure(null, -32600, 'Invalid request');
	}
	const {id, method, params = {}} = parsed.data;
	if (id === undefined || method === undefined) {
		return null;
	}
	if (method === 'initialize') {
		return {jsonrpc: '2.0', id, result: await initialize(signedIn, params)};
	}
	if (method === 'ping') {
		return {jsonrpc: '2.0', id, result: {}};
	}
	if (method === 'tools/list') {
		return {jsonrpc: '2.0', id, result: {tools: MCP_TOOLS}};
	}
	if (method === 'tools/call') {
		const call = callParamsSchema.safeParse(params);
		if (!call.success || !MCP_TOOLS.some((tool) => tool.name === call.data.name)) {
			return failure(id, -32602, `Unknown tool. The tools are ${MCP_TOOLS.map((tool) => tool.name).join(', ')}.`);
		}
		const args = call.data.arguments ?? {};
		// PRE-TASK CLIENTS: whether the call is a pre-task client's (pre-task-clients.ts).
		const preTask = isPreTaskCall(headers, call.data.name, args);
		return {jsonrpc: '2.0', id, result: await callMcpTool(signedIn, call.data.name, args, preTask)};
	}
	return failure(id, -32601, `Method not found: ${method}`);
}

/** `POST /mcp`: one JSON-RPC message, or a batch of them as older clients send. */
export async function handleMcpRoute(req: Request, res: Response): Promise<void> {
	const appUrl = requireAppUrl();
	if (appUrl.isErr()) {
		res.status(500).json({error: 'server_error'});
		return;
	}
	const signedIn = await authenticateBearer(req.headers);
	if (signedIn.isErr() && signedIn.error.kind === 'unauthenticated') {
		res.status(401).setHeader('WWW-Authenticate', wwwAuthenticate(appUrl.value, req.headers)).json({error: 'invalid_token'});
		return;
	}
	if (signedIn.isErr()) {
		log.error('MCP sign-in failed', serializeError(signedIn.error));
		res.status(500).json({error: 'server_error'});
		return;
	}

	const version = req.headers['mcp-protocol-version'];
	if (typeof version === 'string' && !PROTOCOL_VERSIONS.includes(version)) {
		res.status(400).json(failure(null, -32600, `Unsupported MCP-Protocol-Version ${version}`));
		return;
	}

	const body: unknown = req.body;
	const messages: unknown[] = Array.isArray(body) ? body : [body];
	const answers: JsonRpcResponse[] = [];
	for (const message of messages) {
		const reply = await answer(signedIn.value, message, req.headers);
		if (reply) {
			answers.push(reply);
		}
	}
	if (messages.some((message) => isMethod(message, 'initialize'))) {
		res.setHeader('Mcp-Session-Id', `${randomUUID()}.${TOOLS_VERSION}`);
	}
	if (answers.length === 0) {
		res.status(202).end();
		return;
	}
	if (holdsOldTools(req, messages)) {
		res.setHeader('Content-Type', 'text/event-stream').setHeader('Cache-Control', 'no-cache');
		res.end([LIST_CHANGED, ...answers].map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join(''));
		return;
	}
	res.json(Array.isArray(body) ? answers : answers[0]);
}

function isMethod(message: unknown, method: string): boolean {
	return messageSchema.safeParse(message).data?.method === method;
}

function toolCalls(messages: unknown[]): Array<z.infer<typeof callParamsSchema>> {
	return messages.flatMap((message) => {
		const parsed = messageSchema.safeParse(message);
		if (parsed.data?.method !== 'tools/call') {
			return [];
		}
		const call = callParamsSchema.safeParse(parsed.data.params ?? {});
		return call.success ? [call.data] : [];
	});
}

// Whether the request calls a tool from a session from before the tool list last changed, and
// the client can take a stream to be told so. A client with no session, or one that only takes
// JSON, can't be told.
function holdsOldTools(req: Request, messages: unknown[]): boolean {
	const calls = toolCalls(messages);
	const accept = req.headers.accept ?? '';
	if (calls.length === 0 || !accept.includes('text/event-stream')) {
		return false;
	}
	// PRE-TASK CLIENTS: a pre-task client's call is told too, so it fetches the list with start_task.
	if (calls.some((call) => isPreTaskCall(req.headers, call.name, call.arguments ?? {}))) {
		return true;
	}
	const session = req.headers['mcp-session-id'];
	return typeof session === 'string' && !session.endsWith(`.${TOOLS_VERSION}`);
}

/** `GET` and `DELETE /mcp`: there is no stream to open and no session to end. */
export function handleMcpMethodNotAllowedRoute(_req: Request, res: Response): void {
	res
		.status(405)
		.setHeader('Allow', 'POST')
		.json(failure(null, -32000, 'Method not allowed: POST JSON-RPC to /mcp'));
}
