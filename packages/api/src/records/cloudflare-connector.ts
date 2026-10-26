import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {CLOUDFLARE, endpointsCode, isGraphqlPath, requestCode, requestPath, type CloudflareRequest, type Json} from '../connections/cloudflare/cloudflare-mcp';
import {callMcpToolFor} from '../connections/mcp/mcp-session';
import {onlyRun, type Connector, type DataRecord, type NewCommandRunner, type RecordValues} from './connector';

/**
 * A Cloudflare account, through Cloudflare's MCP server, fetched live with the connection's
 * tokens. Requests, searches of the API reference and of the docs are only run, never listed,
 * opened or kept. Each of the request commands sends only the methods of its own action, so what
 * an agent may do follows from what the request is, whatever the sign-in allows: Read sends GET
 * and GraphQL analytics queries, Send POST, PUT and PATCH, and Delete DELETE.
 */

// The most of an answer passed on, as of a web page: Cloudflare's server is asked for its answers
// whole, so a long one is cut here, saying so where nothing could take the note for an answer's own.
const MAX_RESPONSE_CHARACTERS = 100_000;

// An answer, whole, or its start and a line after it saying how much was left out and how to ask
// for less, which leaves cut JSON plainly unfinished rather than a list that looks complete.
function passedOn(answer: string): string {
	if (answer.length <= MAX_RESPONSE_CHARACTERS) {
		return answer;
	}
	const total = answer.length.toLocaleString('en-US');
	const kept = MAX_RESPONSE_CHARACTERS.toLocaleString('en-US');
	return `${answer.slice(0, MAX_RESPONSE_CHARACTERS)}\n\n[Cut short: Cloudflare answered with ${total} characters, of which these are the first ${kept}. Ask for less at once, such as a page at a time with ?page=1&per_page=20, or a narrower filter.]`;
}

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
	return Result.wrap((): Json => JSON.parse(text))
		.map((body) => ({body}))
		.mapErr(() => ApiErr.validationError('The body is JSON, such as {"type": "A", "name": "www", "content": "192.0.2.1"}'));
}

// GraphQL's strings, block strings first, and its comments, matched together so a `#` in a string
// is no comment and a quote in a comment no string: what they say is never an operation.
const GRAPHQL_TEXT = /"""[\s\S]*?"""|"(?:\\.|[^"\\\n\r])*"|#[^\n\r]*/g;

// A document with a mutation or a subscription in it anywhere, its strings and comments left out:
// a document may hold several operations, any of them first, and `operationName` pick another.
const WRITES = /\b(mutation|subscription)\b/i;

// A GraphQL query that only reads: Cloudflare's analytics, never a mutation.
function readsOnly(body: CloudflareRequest['body']): boolean {
	const query = typeof body === 'object' && body !== null && !Array.isArray(body) ? body.query : undefined;
	return typeof query === 'string' && !WRITES.test(query.replace(GRAPHQL_TEXT, ' '));
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
		// Cloudflare's sandbox turns down a GET with a body, so it is turned down here first, saying why.
		if (method === 'GET' && body !== undefined) {
			return $(Err(ApiErr.validationError('A GET request has no body: put what it asks for in its path, such as /zones?name=example.com')));
		}
		return {method, path, ...(body === undefined ? {} : {body})};
	});
}

function sendRequest(sends: Sends): NewCommandRunner {
	return (target, values) =>
		Do(async ($): Promise<DataRecord> => {
			const request = $(cloudflareRequest(sends, values));
			const account = (values.account ?? '').trim();
			const response = passedOn($(await callMcpToolFor(CLOUDFLARE, target.connection, 'execute', {code: requestCode(request), ...(account ? {account_id: account} : {})})));
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

export const cloudflareConnector: Connector = {
	...onlyRun('Requests and searches are only run, never listed or kept'),
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
				const endpoints = passedOn($(await callMcpToolFor(CLOUDFLARE, target.connection, 'search', {code: endpointsCode(search)})));
				return {id: 'endpoints', values: {search, endpoints}, updatedAt: new Date().toISOString()};
			}),
		run: (target, values) =>
			Do(async ($): Promise<DataRecord> => {
				const query = (values.query ?? '').trim();
				if (!query) {
					return $(Err(ApiErr.validationError('Say what to search the docs for')));
				}
				const results = passedOn($(await callMcpToolFor(CLOUDFLARE, target.connection, 'docs', {query})));
				return {id: 'docs', values: {query, results}, updatedAt: new Date().toISOString()};
			}),
	},
};
