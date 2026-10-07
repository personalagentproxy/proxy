import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, httpRequest, parseSchema} from '@proxy/utils';

import type {McpServer} from './mcp-oauth';

/**
 * An MCP server, called one tool at a time. Granola's and Notion's servers keep no session, so
 * each call is a single JSON-RPC `tools/call` with the access token, answered as JSON or as a
 * one-event stream.
 */

const TIMEOUT_MS = 30_000;

const toolResponseSchema = z.object({
	result: z
		.object({
			content: z.array(z.object({type: z.string(), text: z.string().optional()})),
			isError: z.boolean().optional(),
		})
		.optional(),
	error: z.object({message: z.string()}).optional(),
});

// The last `data:` line of an event stream, or the body as it is when it is plain JSON.
function jsonRpcBody(body: string): string {
	const events = body
		.split('\n')
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice('data:'.length).trim());
	return events.at(-1) ?? body;
}

/**
 * Calls one of a server's tools, its answer's text. A token the server turns down is
 * `credentials_rejected`, so the caller can refresh it; a tool failing is what the server's
 * `toolError` makes of it, else the server out of reach.
 */
export function callMcpTool(server: McpServer, accessToken: string, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const response = await httpRequest(
			server.url,
			{
				method: 'POST',
				headers: {authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream'},
				body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
			},
			{parse: 'text', timeoutMs: TIMEOUT_MS},
		);
		if (response.isErr() && response.error.kind === 'http' && (response.error.status === 401 || response.error.status === 403)) {
			return $(Err(ApiErr.credentialsRejected()));
		}

		const body = $(response.mapErr((error) => ApiErr.providerUnreachable(error)));
		const json = $(Result.wrap((): unknown => JSON.parse(jsonRpcBody(body))).mapErr((cause) => ApiErr.providerUnreachable(cause)));
		const message = $(parseSchema(toolResponseSchema, json).mapErr((error) => ApiErr.providerUnreachable(error)));
		if (message.error || !message.result) {
			return $(Err(ApiErr.providerUnreachable(new Error(`${server.name}'s ${name} failed: ${message.error?.message ?? 'no result'}`))));
		}

		const text = message.result.content.map((block) => block.text ?? '').join('\n');
		if (message.result.isError) {
			return $(Err(server.toolError?.(text) ?? ApiErr.providerUnreachable(new Error(`${server.name}'s ${name} failed: ${text}`))));
		}
		return text;
	});
}
