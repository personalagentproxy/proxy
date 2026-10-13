import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import type {McpTool} from '@proxy/integrations';

import {checkedRequest} from '../../utils/checked-request';
import {checkUrl} from '../../utils/host-check';
import {listMcpTools} from '../mcp/mcp-client';
import type {McpServer} from '../mcp/mcp-oauth';
import {customEndpoint} from './custom-mcp';

/**
 * Finding out how a custom MCP server is signed in to, as the MCP spec lays it out: the server
 * says, in its protected resource metadata, which authorization server its tokens come from, and
 * that server's metadata names its endpoints. A server that answers without a token needs no
 * sign-in at all. Every request here goes through `checkedRequest`, as every later one to the
 * server does.
 */

const TIMEOUT_MS = 15_000;

/**
 * A server's address as typed in: `https`, or `http` only to a private address, on a host the api
 * may call (`checkUrl`), so the form hears about a private address at once, though every request
 * checks the host again. Sign-in details in the address are refused; a query string stays with it.
 */
export function parseMcpServerUrl(raw: string): Promise<Result<URL, ApiError>> {
	return Do(async ($) => {
		if (!URL.canParse(raw.trim())) {
			return $(Err(ApiErr.validationError('Enter the server’s address, such as https://mcp.example.com/mcp')));
		}
		const url = new URL(raw.trim());
		if (url.username || url.password) {
			return $(Err(ApiErr.validationError('Leave sign-in details out of the address')));
		}
		url.hash = '';
		return $(await checkUrl(url));
	});
}

const protectedResourceSchema = z.object({authorization_servers: z.array(z.string()).optional(), scopes_supported: z.array(z.string()).optional()});

const authorizationServerSchema = z.object({
	authorization_endpoint: z.string(),
	token_endpoint: z.string(),
	registration_endpoint: z.string().optional(),
});

/** What a probe found: the server's tools, reachable as it was asked, or that it asks for a sign-in. */
export type Probe = {kind: 'tools'; tools: McpTool[]} | {kind: 'signIn'};

/**
 * Asks the server for its tools, with the token typed in or none: the tools, or `signIn` when the
 * server turns a request without a token down. A token it turns down is `credentials_rejected`.
 */
export function probeMcpServer(url: URL, token: string | null): Promise<Result<Probe, ApiError>> {
	return Do(async ($) => {
		const listed = await listMcpTools(customEndpoint(url.toString()), token);
		if (listed.isErr() && listed.error.kind === 'credentials_rejected' && token === null) {
			return {kind: 'signIn' as const};
		}
		return {kind: 'tools' as const, tools: $(listed)};
	});
}

// The `resource_metadata` a server's 401 points at, when it points at one (RFC 9728).
async function resourceMetadataUrl(url: URL): Promise<string | null> {
	const response = await checkedRequest(
		url.toString(),
		{
			method: 'POST',
			headers: {'content-type': 'application/json', accept: 'application/json, text/event-stream'},
			body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'personal-agent-proxy', version: '1.0.0'}}}),
		},
		{parse: 'response', allowStatus: () => true, timeoutMs: TIMEOUT_MS},
	);
	if (response.isErr()) {
		return null;
	}
	await Result.wrapAsync(() => response.value.body?.cancel() ?? Promise.resolve());
	const challenge = response.value.headers.get('www-authenticate') ?? '';
	return /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? null;
}

// The well-known places for a resource's or an issuer's metadata: under its path, then at its root.
function wellKnownUrls(base: URL, name: string): string[] {
	const path = base.pathname.replace(/\/$/, '');
	if (path === '') {
		return [`${base.origin}/.well-known/${name}`];
	}
	return [`${base.origin}/.well-known/${name}${path}`, `${base.origin}/.well-known/${name}`];
}

// The first of the addresses that answers with what `schema` reads, if any, each asked once.
async function firstMetadata<T>(urls: string[], schema: z.ZodType<T>): Promise<T | null> {
	for (const url of new Set(urls)) {
		const found = await checkedRequest(url, {headers: {accept: 'application/json'}}, {schema, timeoutMs: TIMEOUT_MS});
		if (found.isOk()) {
			return found.value;
		}
	}
	return null;
}

// The authorization server a resource's metadata names, and the scopes it asks for; the server's
// own origin where it has no metadata, as older servers have none.
async function findAuthorizationServer(url: URL): Promise<{issuer: URL; scopes: string[]}> {
	const pointed = await resourceMetadataUrl(url);
	const metadata = await firstMetadata([...(pointed ? [pointed] : []), ...wellKnownUrls(url, 'oauth-protected-resource')], protectedResourceSchema);
	const issuer = metadata?.authorization_servers?.[0];
	if (!issuer || !URL.canParse(issuer)) {
		return {issuer: new URL(url.origin), scopes: metadata?.scopes_supported ?? []};
	}
	return {issuer: new URL(issuer), scopes: metadata?.scopes_supported ?? []};
}

/**
 * The server and its authorization server, from its address, for signing in: its endpoints as the
 * authorization server's metadata names them, or the usual ones under the issuer where it has
 * none, and the scopes the server's own metadata asks for, none otherwise. An authorization server
 * that doesn't let apps register themselves can't be signed in to.
 */
export function discoverMcpServer(url: URL): Promise<Result<McpServer, ApiError>> {
	return Do(async ($) => {
		const {issuer, scopes} = await findAuthorizationServer(url);
		$((await checkUrl(issuer)).mapErr((error) => ApiErr.validationError(`The server’s authorization server (${issuer.origin}) can’t be used: ${'message' in error ? error.message : error.kind}`)));
		const base = `${issuer.origin}${issuer.pathname.replace(/\/$/, '')}`;
		const metadata = await firstMetadata(
			[...wellKnownUrls(issuer, 'oauth-authorization-server'), ...wellKnownUrls(issuer, 'openid-configuration'), `${base}/.well-known/openid-configuration`],
			authorizationServerSchema,
		);
		const registerUrl = metadata ? metadata.registration_endpoint : `${base}/register`;
		if (!registerUrl) {
			return $(Err(ApiErr.validationError('This server’s sign-in doesn’t let apps register themselves, so Personal Agent Proxy can’t sign in to it')));
		}
		return {
			...customEndpoint(url.toString()),
			registerUrl,
			authorizeUrl: metadata?.authorization_endpoint ?? `${base}/authorize`,
			tokenUrl: metadata?.token_endpoint ?? `${base}/token`,
			scope: scopes.join(' '),
		};
	});
}
