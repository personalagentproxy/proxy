import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {callMcpTool, parseToolJson} from '../mcp/mcp-client';
import type {McpServer} from '../mcp/mcp-oauth';

/**
 * Cloudflare's MCP server, which reaches all of Cloudflare's API with two tools that run code:
 * `execute` runs a JavaScript function calling `cloudflare.request()` with the connection's token,
 * and `search` one reading Cloudflare's OpenAPI document (`spec`). Agents never write that code:
 * each request is one Personal Agent Proxy writes from the request's method, path and body, so a
 * request does only what its method says. Both answer with what the function returned, as JSON
 * cut to about 6,000 tokens; `docs` searches developers.cloudflare.com. A tool that fails says
 * why in words: "Error: Cloudflare API error: GET /zones returned HTTP 403: …".
 */

const BASE = 'https://mcp.cloudflare.com';

// What a sign-in asks for, which Cloudflare's sign-in page starts from and the person can narrow or
// widen there: who signed in and their accounts, refresh tokens, and reading and writing zones,
// DNS, analytics, caching, certificates and the developer platform. A request beyond them is
// turned down, naming the permission it needs, until the person signs in again granting it.
const SCOPES = [
	'user:read',
	'account:read',
	'offline_access',
	'zone.read',
	'zone.write',
	'zone-settings.read',
	'zone-settings.write',
	'dns.read',
	'dns.write',
	'analytics.read',
	'account-analytics.read',
	'cache.purge',
	'cache-settings.read',
	'cache-settings.write',
	'ssl-and-certificates.read',
	'ssl-and-certificates.write',
	'page-rules.read',
	'page-rules.write',
	'zone-waf.read',
	'zone-waf.write',
	'workers-scripts.read',
	'workers-scripts.write',
	'workers-routes.read',
	'workers-routes.write',
	'workers-tail.read',
	'workers-observability.read',
	'workers-kv-storage.read',
	'workers-kv-storage.write',
	'workers-r2.read',
	'workers-r2.write',
	'd1.read',
	'd1.write',
	'page.read',
	'page.write',
	'queues.read',
	'queues.write',
	'query-cache.read',
	'query-cache.write',
	'vectorize.read',
	'vectorize.write',
	'ai.read',
	'ai.write',
	'workers-ci.read',
	'workers-ci.write',
];

const ERROR_PREFIX = /^Error:\s*/;

export const CLOUDFLARE: McpServer = {
	name: 'Cloudflare',
	url: `${BASE}/mcp`,
	registerUrl: `${BASE}/register`,
	authorizeUrl: `${BASE}/authorize`,
	tokenUrl: `${BASE}/token`,
	scope: SCOPES.join(' '),
	// Everything a request fails with, Cloudflare's errors and what permission it needed, is for the
	// model to act on; a token Cloudflare turns down fails at the door instead.
	toolError: (text) => ApiErr.validationError(`Cloudflare turned it down: ${text.trim().replace(ERROR_PREFIX, '') || 'it didn’t say why'}`),
};

// Who a credential is: a user, by their email, for a sign-in or a user's token; an account, by its
// name, for an account's token. The id never changes.
const whoamiSchema = z.object({id: z.string(), email: z.string().optional(), name: z.string().optional()});

/**
 * The Cloudflare account a sign-in or token is for, as the connection shows it: the email of who
 * signed in, or whose token it is, or the account an account's token is for, by name. Signing in
 * again as the same person renews their connection.
 */
export function getCloudflareAccount(token: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const who = $(parseToolJson($(await callMcpTool(CLOUDFLARE, token, 'whoami', {})), whoamiSchema));
		return who.email?.toLowerCase() ?? who.name ?? who.id;
	});
}

type Json = z.infer<typeof jsonSchema>;

const jsonSchema = z.json();

/** A request's body, as JSON. */
export const requestBodySchema = jsonSchema;

/** A request to Cloudflare's API, as `cloudflare.request()` takes it. */
export type CloudflareRequest = {method: string; path: string; body?: Json};

/**
 * The function `execute` runs for one request: it sends the request as it is, `{account_id}` in
 * its path the account the call is for, and returns Cloudflare's answer. Everything the request
 * says is written in as JSON, so nothing of it runs as code.
 */
export function requestCode(request: CloudflareRequest): string {
	return [
		'async () => {',
		`\tconst request = ${JSON.stringify(request)};`,
		"\tconst path = request.path.includes('{account_id}') ? request.path.replaceAll('{account_id}', accountId) : request.path;",
		'\treturn cloudflare.request({...request, path});',
		'}',
	].join('\n');
}

// Cloudflare's OpenAPI document, as far as a search reads it, its references already filled in.
type ApiOperation = {
	summary?: string;
	description?: string;
	// The products it is part of: "DNS Records for a Zone".
	tags?: string[];
	parameters?: Json;
	requestBody?: {content?: Record<string, {schema?: Json}>};
};

type ApiMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type ApiSpec = {paths: Record<string, Partial<Record<ApiMethod, ApiOperation>>>};

/** One endpoint, as a search for it answers. */
export type EndpointDetails = {endpoint: string; summary?: string; description?: string; parameters?: Json; body?: Json};

/**
 * A search of the API reference, run in Cloudflare's sandbox, where `spec` is the document: one
 * endpoint, "POST /zones/{zone_id}/dns_records", answers with its summary, parameters and JSON
 * body; words, "dns records", with every endpoint whose method, path, summary or product has each
 * of them, one a line, "GET /zones/{zone_id}/dns_records List DNS Records", the first `max`. It is
 * sent as its source, so it uses nothing from around it.
 */
export function findEndpoints(search: string, spec: ApiSpec, max: number): string | EndpointDetails {
	const methods: ApiMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
	const one = /^(\w+)\s+(\/\S*)$/.exec(search);
	const method = methods.find((candidate) => candidate === one?.[1]?.toLowerCase());
	const operation = one?.[2] && method ? spec.paths[one[2]]?.[method] : undefined;
	if (one?.[2] && method && operation) {
		const content = operation.requestBody?.content;
		return {
			endpoint: `${method.toUpperCase()} ${one[2]}`,
			summary: operation.summary,
			description: operation.description,
			parameters: operation.parameters,
			body: content?.['application/json']?.schema ?? (content ? Object.keys(content).join(', ') : undefined),
		};
	}

	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	const found: string[] = [];
	for (const [path, item] of Object.entries(spec.paths)) {
		for (const candidate of methods) {
			const endpoint = item[candidate];
			const text = endpoint ? [candidate, path, endpoint.summary ?? '', ...(endpoint.tags ?? [])].join(' ').toLowerCase() : '';
			if (endpoint && words.every((word) => text.includes(word))) {
				found.push(`${candidate.toUpperCase()} ${path} ${endpoint.summary ?? ''}`.trim());
			}
		}
	}
	if (found.length === 0) {
		return 'No endpoint has every one of those words: try fewer, or other words for the product.';
	}
	const more = found.length > max ? [`and ${found.length - max} more: add words to narrow it`] : [];
	return [...found.slice(0, max), ...more].join('\n');
}

// How many endpoints a search lists before asking for a narrower one.
const MAX_ENDPOINTS = 50;

/** The function `search` runs for a search of the API reference: `findEndpoints`, the search written in as JSON. */
export function endpointsCode(search: string): string {
	return `async () => (${findEndpoints.toString()})(${JSON.stringify(search)}, spec, ${MAX_ENDPOINTS})`;
}

// GraphQL analytics queries are sent to `/graphql`, as a POST, and only read.
const GRAPHQL_PATH = /^\/graphql\/?(\?|$)/;

/** Whether a path is Cloudflare's GraphQL analytics API. */
export function isGraphqlPath(path: string): boolean {
	return GRAPHQL_PATH.test(path);
}

const API_ORIGIN = /^https:\/\/api\.cloudflare\.com\/client\/v4(?=\/)/;

/** A path as the API reference writes it, from one with or without the API's own address before it. */
export function requestPath(raw: string): Result<string, ApiError> {
	const path = raw.trim().replace(API_ORIGIN, '');
	if (!path.startsWith('/') || /\s/.test(path)) {
		return Err(ApiErr.validationError('Give the path as Cloudflare’s API reference writes it, such as /zones or /accounts/{account_id}/workers/scripts'));
	}
	return Ok(path);
}
