import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';

import {CLOUDFLARE, endpointsCode, isGraphqlPath, requestBodySchema, requestCode, requestPath, type CloudflareRequest} from '../connections/cloudflare/cloudflare-mcp';
import {callMcpToolFor} from '../connections/mcp/mcp-session';
import type {Connector, DataRecord, NewCommandRunner, RecordTarget, RecordValues} from './connector';

/**
 * A Cloudflare account, through Cloudflare's MCP server, fetched live with the connection's
 * tokens. Requests, searches of the API reference and of the docs are only run, never listed,
 * opened or kept. Each of the request commands sends only the methods of its own action, so what
 * an agent may do follows from what the request is, whatever the sign-in allows: Read sends GET
 * and GraphQL analytics queries, Send POST, PUT and PATCH, and Delete DELETE.
 */

type Connection = RecordTarget['connection'];

// What each request command sends: the methods it takes, the one a request without a method is
// sent with, and what to tell an agent that asked it for another.
type Sends = {methods: string[]; method: string; refused: string};

const READ: Sends = {methods: ['GET'], method: 'GET', refused: 'Read sends only GET requests and GraphQL queries to /graphql'};
const SEND: Sends = {methods: ['POST', 'PUT', 'PATCH'], method: 'POST', refused: 'Send sends only POST, PUT and PATCH requests'};
const REMOVE: Sends = {methods: ['DELETE'], method: 'DELETE', refused: 'Delete sends only DELETE requests'};

// A body typed in, as JSON; none when left empty.
function requestBody(raw: string | undefined): Result<Pick<CloudflareRequest, 'body'>, ApiError> {
	const text = (raw ?? '').trim();
	if (text === '') {
		return Ok({});
	}
	const json = Result.wrap((): unknown => JSON.parse(text)).mapErr(() => ApiErr.validationError('The body is JSON, such as {"type": "A", "name": "www", "content": "192.0.2.1"}'));
	return json.andThen((value) => parseSchema(requestBodySchema, value)).map((body) => ({body}));
}

// A GraphQL query that only reads: Cloudflare's analytics, never a mutation.
function readsOnly(body: CloudflareRequest['body']): boolean {
	const query = typeof body === 'object' && body !== null && !Array.isArray(body) ? body.query : undefined;
	return typeof query === 'string' && !/^\s*mutation\b/i.test(query);
}

// The request a command sends from the values typed in, as long as it is one the command sends.
function cloudflareRequest(sends: Sends, values: RecordValues): Result<CloudflareRequest, ApiError> {
	return Do<CloudflareRequest, ApiError>(($): CloudflareRequest => {
		const path = $(requestPath(values.path ?? ''));
		const asked = (values.method ?? '').trim().toUpperCase();
		const {body} = $(requestBody(values.body));
		if (sends === READ && isGraphqlPath(path)) {
			if (!['', 'POST'].includes(asked) || !readsOnly(body)) {
				return $(Err(ApiErr.validationError('A GraphQL analytics query is a POST to /graphql, its body {"query": "…", "variables": {…}}')));
			}
			return {method: 'POST', path, body};
		}
		const method = asked === '' ? sends.method : asked;
		if (!sends.methods.includes(method)) {
			return $(Err(ApiErr.validationError(`${sends.refused}, not ${method}`)));
		}
		return {method, path, ...(body === undefined ? {} : {body})};
	});
}

// Runs one of the server's tools for the connection, its answer as it is.
function call(connection: Connection, tool: string, args: Record<string, string>): Promise<Result<string, ApiError>> {
	return callMcpToolFor(CLOUDFLARE, connection, tool, args);
}

function sendRequest(sends: Sends): NewCommandRunner {
	return (target, values) =>
		Do(async ($): Promise<DataRecord> => {
			const request = $(cloudflareRequest(sends, values));
			const account = (values.account ?? '').trim();
			const response = $(await call(target.connection, 'execute', {code: requestCode(request), ...(account ? {account_id: account} : {})}));
			const sent: RecordValues = {method: request.method, path: request.path};
			const body = (values.body ?? '').trim();
			if (body) {
				sent.body = body;
			}
			if (account) {
				sent.account = account;
			}
			return {id: 'request', values: {...sent, response}, updatedAt: new Date().toISOString()};
		});
}

function onlyRun<T>(): Promise<Result<T, ApiError>> {
	return Promise.resolve(Err(ApiErr.validationError('Requests and searches are only run, never listed or kept')));
}

export const cloudflareConnector: Connector = {
	list: () => onlyRun(),
	get: () => onlyRun(),
	create: () => onlyRun(),
	update: () => onlyRun(),
	remove: () => onlyRun(),
	newCommands: {
		read: sendRequest(READ),
		send: sendRequest(SEND),
		remove: sendRequest(REMOVE),
		find: (target, values) =>
			Do(async ($): Promise<DataRecord> => {
				const search = (values.search ?? '').trim();
				if (!search) {
					return $(Err(ApiErr.validationError('Say what to look up: words, such as "dns records", or one endpoint, such as "POST /zones/{zone_id}/dns_records"')));
				}
				const endpoints = $(await call(target.connection, 'search', {code: endpointsCode(search)}));
				return {id: 'endpoints', values: {search, endpoints}, updatedAt: new Date().toISOString()};
			}),
		run: (target, values) =>
			Do(async ($): Promise<DataRecord> => {
				const query = (values.query ?? '').trim();
				if (!query) {
					return $(Err(ApiErr.validationError('Say what to search the docs for')));
				}
				const results = $(await call(target.connection, 'docs', {query}));
				return {id: 'docs', values: {query, results}, updatedAt: new Date().toISOString()};
			}),
	},
};
