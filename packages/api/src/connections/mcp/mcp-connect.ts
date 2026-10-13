import {randomBytes} from 'node:crypto';

import type {Response} from 'express';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseCookieHeader, parseSchema, requirePresent} from '@proxy/utils';
import {createConnection, listConnections, updateConnectionCredential, updateConnectionTools, type ConnectionRow} from '@proxy/db/connection';
import type {IntegrationId, McpTool} from '@proxy/integrations';

import {queryParam, timingSafeEqualString, useSecureCookies} from '../../auth/session';
import {log, serializeError} from '../../observability/log';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {env} from '../../utils/env';
import {decryptSecret, encryptSecret} from '../../utils/secret-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {exchangeMcpCode, makePkce, mcpAuthorizeUrl, mcpEndpoints, mcpEndpointsSchema, registerMcpClient, type McpServer, type McpSignIn} from './mcp-oauth';

/**
 * Connecting an integration by signing in to its MCP server, as Granola, Notion and Linear are, and
 * a custom server by its address. A sign-in begins on the api, which registers Personal Agent Proxy
 * with the server and keeps the handshake in a short-lived encrypted cookie, and the browser goes
 * to the server's sign-in page: from the start route, a top-level navigation, for a server known
 * in advance, or from the custom connect route's answer for one found from its address. The
 * callback, under `/api/connections/<integration>/callback`, trades the code for tokens and makes
 * the connection, or gives an existing one of the same account its new tokens, and ends on the
 * connection's page, or back on the catalog with `?error=<integration>`; a sign-in begun from the
 * welcome flow (`returnTo: 'welcome'`) ends on its page for the connection, or its catalog, instead.
 */

const stateCookieMaxAgeMs = 15 * 60 * 1000;

/** Where a sign-in ends when not on the connection's page: the welcome flow it began from. */
export const returnToSchema = z.enum(['welcome']);

export type ReturnTo = z.infer<typeof returnToSchema>;

// The server is kept only when it was found from the request, as a custom one is.
const statePayloadSchema = z.object({
	state: z.string(),
	verifier: z.string(),
	clientId: z.string(),
	userId: z.string(),
	returnTo: returnToSchema.optional(),
	server: mcpEndpointsSchema.optional(),
});

type StatePayload = z.infer<typeof statePayloadSchema>;

type Route = (request: AuthenticatedRequest, res: Response) => Promise<void>;

/** The connection a finished sign-in makes: its account, what it stores (encrypted), what agents get by default, and a custom server's tools. */
export type McpConnection = {account: string; credential: Record<string, unknown>; defaults: string[]; tools?: McpTool[]};

type MakeConnection = (signIn: McpSignIn, server: McpServer) => Promise<Result<McpConnection, ApiError>>;

/**
 * Saves a connection to an MCP server: a new one, or an existing one of the same account given
 * the new credential, and the tools, where the server has its own.
 */
export function saveMcpConnection(orgId: string, integrationId: IntegrationId, made: McpConnection): Promise<Result<ConnectionRow, ApiError>> {
	return Do(async ($) => {
		const encrypted = $(encryptSecret(JSON.stringify(made.credential)));
		const existing = $(await listConnections(orgId)).find((connection) => connection.integrationId === integrationId && connection.account === made.account);
		if (!existing) {
			const tools = made.tools === undefined ? {} : {tools: JSON.stringify(made.tools)};
			return $(await createConnection({orgId, integrationId, account: made.account, credential: encrypted, defaults: made.defaults, ...tools}));
		}
		$(await updateConnectionCredential({connectionId: existing.id, credential: encrypted}));
		if (made.tools === undefined) {
			return existing;
		}
		const tools = JSON.stringify(made.tools);
		$(await updateConnectionTools({connectionId: existing.id, tools, actions: made.tools.map((tool) => tool.name)}));
		return {...existing, tools};
	});
}

/**
 * The sign-in to one integration's server, known in advance as Granola's is, or found per request
 * as a custom one is from its address (`server: null`) and kept in the handshake cookie for the
 * callback: `beginSignIn` for the route that has the server, and the callback route.
 */
export function mcpSignInRoutes(flow: {integrationId: IntegrationId; name: string; server: McpServer | null; connection: MakeConnection}) {
	const {integrationId, name} = flow;
	const stateCookieName = `proxy.${integrationId}-state`;
	// Only sent to these routes.
	const basePath = `/api/connections/${integrationId}`;

	function redirectUri(appUrl: string): string {
		return `${appUrl}${basePath}/callback`;
	}

	function stateCookieOptions() {
		return {httpOnly: true, sameSite: 'lax' as const, secure: useSecureCookies(), path: basePath};
	}

	function readStateCookie(request: AuthenticatedRequest): Result<StatePayload, ApiError> {
		return Do<StatePayload, ApiError>(($) => {
			const cookie = parseCookieHeader(request.headers.cookie ?? '').get(stateCookieName);
			const stored = $(requirePresent(cookie, ApiErr.validationError(`No ${name} sign-in under way`)));
			const json = $(decryptSecret(stored));
			const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
			return $(parseSchema(statePayloadSchema, parsed));
		});
	}

	// The server the sign-in was to: the one known in advance, or the one the cookie kept.
	function serverAtCallback(payload: StatePayload): Result<McpServer, ApiError> {
		if (flow.server) {
			return Ok(flow.server);
		}
		return requirePresent(payload.server, ApiErr.validationError(`The ${name} sign-in under way names no server`));
	}

	// Where the sign-in ends: the catalog, or the welcome flow's connections step it started from.
	function catalogUrl(appUrl: string, returnTo: ReturnTo | undefined): string {
		if (returnTo === 'welcome') {
			return `${appUrl}/welcome/connections`;
		}
		return `${appUrl}/connections/new`;
	}

	function redirectToConnectError(res: Response, appUrl: string, returnTo: ReturnTo | undefined, error: ApiError): void {
		log.warn(`Connecting ${name} failed`, {kind: error.kind, ...('message' in error ? {message: error.message} : {}), ...('cause' in error ? serializeError(error.cause) : {})});
		res.redirect(`${catalogUrl(appUrl, returnTo)}?error=${integrationId}`);
	}

	/** Registers with the server, keeps the handshake in a cookie on `res`, and answers the server's sign-in page, for the browser to go to. */
	function beginSignIn(res: Response, args: {userId: string; server: McpServer; returnTo: ReturnTo | undefined}): Promise<Result<string, ApiError>> {
		return Do(async ($) => {
			const appUrl = $(requirePresent(env.APP_URL, ApiErr.internalError(new Error('APP_URL is not configured'))));
			const clientId = $(await registerMcpClient(args.server, redirectUri(appUrl)));
			const state = randomBytes(16).toString('hex');
			const {verifier, challenge} = makePkce();
			const kept = flow.server ? {} : {server: mcpEndpoints(args.server)};
			const payload: StatePayload = {state, verifier, clientId, userId: args.userId, ...(args.returnTo ? {returnTo: args.returnTo} : {}), ...kept};
			const cookie = $(encryptSecret(JSON.stringify(payload)));
			res.cookie(stateCookieName, cookie, {...stateCookieOptions(), maxAge: stateCookieMaxAgeMs});
			return mcpAuthorizeUrl(args.server, {clientId, redirectUri: redirectUri(appUrl), state, challenge});
		});
	}

	// The handshake the cookie holds, checked against the server's answer, then the connection made
	// or given its new tokens.
	function finishConnect(request: AuthenticatedRequest, appUrl: string, payload: StatePayload): Promise<Result<string, ApiError>> {
		return Do(async ($) => {
			const state = queryParam(request, 'state') ?? '';
			if (!timingSafeEqualString(state, payload.state) || payload.userId !== request.user.userId) {
				return $(Err(ApiErr.validationError(`${name} sign-in state does not match`)));
			}

			const code = queryParam(request, 'code');
			if (!code) {
				return $(Err(ApiErr.validationError(`${name} sign-in ended without a code: ${queryParam(request, 'error') ?? 'unknown'}`)));
			}

			const server = $(serverAtCallback(payload));
			const signIn = $(await exchangeMcpCode(server, {clientId: payload.clientId, redirectUri: redirectUri(appUrl), code, verifier: payload.verifier}));
			const made = $(await flow.connection(signIn, server));
			const orgId = $(await requireUserOrgId(request));
			return $(await saveMcpConnection(orgId, integrationId, made)).id;
		});
	}

	/**
	 * `GET /api/connections/<integration>/callback` — where the sign-in comes back to; lands on the
	 * connection, saying it was added, or on the welcome flow's page for it when it started there.
	 */
	async function handleCallback(request: AuthenticatedRequest, res: Response): Promise<void> {
		const appUrl = env.APP_URL;
		if (!appUrl) {
			res.status(500).json({error: 'app_url_not_configured'});
			return;
		}

		// The handshake is single-use: cleared however the callback ends.
		res.clearCookie(stateCookieName, stateCookieOptions());
		const payload = readStateCookie(request);
		const returnTo = payload.isOk() ? payload.value.returnTo : undefined;
		const connectionId = payload.isErr() ? Err(payload.error) : await finishConnect(request, appUrl, payload.value);
		if (connectionId.isErr()) {
			redirectToConnectError(res, appUrl, returnTo, connectionId.error);
			return;
		}
		if (returnTo === 'welcome') {
			res.redirect(`${appUrl}/welcome/connections/${connectionId.value}`);
			return;
		}
		res.redirect(`${appUrl}/connections/${connectionId.value}?added`);
	}

	return {beginSignIn, handleCallback, redirectToConnectError};
}

/** The routes for a server known in advance, as Granola's is: the start, a top-level navigation, and the callback. */
export function mcpConnectRoutes(args: {integrationId: IntegrationId; server: McpServer; connection: MakeConnection}): {handleStart: Route; handleCallback: Route} {
	const flow = mcpSignInRoutes({...args, name: args.server.name});

	/** `GET /api/connections/<integration>/start` — registers with the server and sends the browser to its sign-in. */
	async function handleStart(request: AuthenticatedRequest, res: Response): Promise<void> {
		const appUrl = env.APP_URL;
		if (!appUrl) {
			res.status(500).json({error: 'app_url_not_configured'});
			return;
		}

		const returnTo = returnToSchema.safeParse(queryParam(request, 'returnTo')).data;
		const begun = await flow.beginSignIn(res, {userId: request.user.userId, server: args.server, returnTo});
		if (begun.isErr()) {
			flow.redirectToConnectError(res, appUrl, returnTo, begun.error);
			return;
		}
		res.redirect(begun.value);
	}

	return {handleStart, handleCallback: flow.handleCallback};
}
