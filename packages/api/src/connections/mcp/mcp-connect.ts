import {randomBytes} from 'node:crypto';

import type {Response} from 'express';
import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseCookieHeader, parseSchema, requirePresent} from '@proxy/utils';
import {createConnection, listConnections, updateConnectionCredential} from '@proxy/db/connection';
import type {IntegrationId, McpTool} from '@proxy/integrations';

import {queryParam, timingSafeEqualString, useSecureCookies} from '../../auth/session';
import {log, serializeError} from '../../observability/log';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {env} from '../../utils/env';
import {decryptSecret, encryptSecret} from '../../utils/secret-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {exchangeMcpCode, makePkce, mcpAuthorizeUrl, mcpEndpointsSchema, registerMcpClient, type McpServer, type McpSignIn} from './mcp-oauth';

/**
 * Connecting an integration by signing in to its MCP server, as Granola, Notion and Linear are, and
 * a custom server by its address. Both routes are top-level browser navigations, under
 * `/api/connections/<integration>`: the start registers Personal Agent Proxy with the server and
 * sends the browser to its sign-in, keeping the handshake in a short-lived encrypted cookie; the
 * callback trades the code for tokens and makes the connection, or gives an existing one of the
 * same account its new tokens. Either ends on the connection's page, or back on the catalog with
 * `?error=<integration>`; started from the welcome flow (`?returnTo=welcome`), they end on its
 * page for the connection, or its catalog, instead.
 */

const stateCookieMaxAgeMs = 15 * 60 * 1000;

const returnToSchema = z.enum(['welcome']);

// The server is kept only when it was found from the start request, as a custom one is.
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

// The server, known in advance as Granola's is, or found from the start request, as a custom one
// is from its address, and kept in the handshake cookie for the callback.
type ServerSource = McpServer | {name: string; resolve: (request: AuthenticatedRequest) => Promise<Result<McpServer, ApiError>>};

export function mcpConnectRoutes(args: {integrationId: IntegrationId; server: ServerSource; connection: (signIn: McpSignIn, server: McpServer) => Promise<Result<McpConnection, ApiError>>}): {
	handleStart: Route;
	handleCallback: Route;
} {
	const {integrationId} = args;
	const name = args.server.name;
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

	// The server a sign-in is to: the one known in advance, or the one the start found.
	function serverAtStart(request: AuthenticatedRequest): Promise<Result<McpServer, ApiError>> {
		if ('resolve' in args.server) {
			return args.server.resolve(request);
		}
		return Promise.resolve(Result.wrap(() => args.server as McpServer).mapErr((cause) => ApiErr.internalError(cause)));
	}

	function serverAtCallback(payload: StatePayload): Result<McpServer, ApiError> {
		if (!('resolve' in args.server)) {
			return Result.wrap(() => args.server as McpServer).mapErr((cause) => ApiErr.internalError(cause));
		}
		return requirePresent(payload.server, ApiErr.validationError(`The ${name} sign-in under way names no server`));
	}

	// Where the sign-in ends: the catalog, or the welcome flow's connections step it started from.
	function catalogUrl(appUrl: string, returnTo: StatePayload['returnTo']): string {
		if (returnTo === 'welcome') {
			return `${appUrl}/welcome/connections`;
		}
		return `${appUrl}/connections/new`;
	}

	function redirectToConnectError(res: Response, appUrl: string, returnTo: StatePayload['returnTo'], error: ApiError): void {
		log.warn(`Connecting ${name} failed`, {kind: error.kind, ...('message' in error ? {message: error.message} : {}), ...('cause' in error ? serializeError(error.cause) : {})});
		res.redirect(`${catalogUrl(appUrl, returnTo)}?error=${integrationId}`);
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
			const made = $(await args.connection(signIn, server));
			const encrypted = $(encryptSecret(JSON.stringify(made.credential)));
			const tools = made.tools === undefined ? {} : {tools: JSON.stringify(made.tools)};

			const orgId = $(await requireUserOrgId(request));
			const existing = $(await listConnections(orgId)).find((connection) => connection.integrationId === integrationId && connection.account === made.account);
			if (existing) {
				$(await updateConnectionCredential({connectionId: existing.id, credential: encrypted, ...tools}));
				return existing.id;
			}

			const row = $(await createConnection({orgId, integrationId, account: made.account, credential: encrypted, defaults: made.defaults, ...tools}));
			return row.id;
		});
	}

	/** `GET /api/connections/<integration>/start` — registers with the server and sends the browser to its sign-in. */
	async function handleStart(request: AuthenticatedRequest, res: Response): Promise<void> {
		const appUrl = env.APP_URL;
		if (!appUrl) {
			res.status(500).json({error: 'app_url_not_configured'});
			return;
		}

		const returnTo = returnToSchema.safeParse(queryParam(request, 'returnTo')).data;
		const started = await Do<{cookie: string; url: string}, ApiError>(async ($) => {
			const server = $(await serverAtStart(request));
			const clientId = $(await registerMcpClient(server, redirectUri(appUrl)));
			const state = randomBytes(16).toString('hex');
			const {verifier, challenge} = makePkce();
			const kept = 'resolve' in args.server ? {server: mcpEndpointsSchema.parse(server)} : {};
			const payload: StatePayload = {state, verifier, clientId, userId: request.user.userId, ...(returnTo ? {returnTo} : {}), ...kept};
			const cookie = $(encryptSecret(JSON.stringify(payload)));
			return {cookie, url: mcpAuthorizeUrl(server, {clientId, redirectUri: redirectUri(appUrl), state, challenge})};
		});
		if (started.isErr()) {
			redirectToConnectError(res, appUrl, returnTo, started.error);
			return;
		}

		res.cookie(stateCookieName, started.value.cookie, {...stateCookieOptions(), maxAge: stateCookieMaxAgeMs});
		res.redirect(started.value.url);
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

	return {handleStart, handleCallback};
}
