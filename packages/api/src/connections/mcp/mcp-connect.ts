import {randomBytes} from 'node:crypto';

import type {Response} from 'express';
import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseCookieHeader, parseSchema, requirePresent} from '@proxy/utils';
import {createConnection, listConnections, updateConnectionCredential} from '@proxy/db/connection';
import type {IntegrationId} from '@proxy/integrations';

import {queryParam, timingSafeEqualString, useSecureCookies} from '../../auth/session';
import {log, serializeError} from '../../observability/log';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {env} from '../../utils/env';
import {decryptSecret, encryptSecret} from '../../utils/secret-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {exchangeMcpCode, makePkce, mcpAuthorizeUrl, registerMcpClient, type McpServer, type McpSignIn} from './mcp-oauth';

/**
 * Connecting an integration by signing in to its MCP server, as Granola and Notion are. Both routes
 * are top-level browser navigations, under `/api/connections/<integration>`: the start registers
 * Personal Agent Proxy with the server and sends the browser to its sign-in, keeping the handshake
 * in a short-lived encrypted cookie; the callback trades the code for tokens and makes the
 * connection, or gives an existing one of the same account its new tokens. Either ends on the
 * connection's page, or back on the catalog with `?error=<integration>`.
 */

const stateCookieMaxAgeMs = 15 * 60 * 1000;

const statePayloadSchema = z.object({state: z.string(), verifier: z.string(), clientId: z.string(), userId: z.string()});

type StatePayload = z.infer<typeof statePayloadSchema>;

type Route = (request: AuthenticatedRequest, res: Response) => Promise<void>;

export function mcpConnectRoutes(args: {
	integrationId: IntegrationId;
	server: McpServer;
	// The actions agents get with a new connection.
	defaults: string[];
	// The account a sign-in is for, as the connection shows it: two sign-ins to the same one are
	// the same connection.
	account: (signIn: McpSignIn) => Promise<Result<string, ApiError>>;
}): {handleStart: Route; handleCallback: Route} {
	const {integrationId, server} = args;
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
			const stored = $(requirePresent(cookie, ApiErr.validationError(`No ${server.name} sign-in under way`)));
			const json = $(decryptSecret(stored));
			const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
			return $(parseSchema(statePayloadSchema, parsed));
		});
	}

	function redirectToConnectError(res: Response, appUrl: string, error: ApiError): void {
		log.warn(`Connecting ${server.name} failed`, {kind: error.kind, ...('message' in error ? {message: error.message} : {}), ...('cause' in error ? serializeError(error.cause) : {})});
		res.redirect(`${appUrl}/connections/new?error=${integrationId}`);
	}

	// The handshake the cookie holds, checked against the server's answer, then the connection made
	// or given its new tokens.
	function finishConnect(request: AuthenticatedRequest, appUrl: string): Promise<Result<string, ApiError>> {
		return Do(async ($) => {
			const payload = $(readStateCookie(request));
			const state = queryParam(request, 'state') ?? '';
			if (!timingSafeEqualString(state, payload.state) || payload.userId !== request.user.userId) {
				return $(Err(ApiErr.validationError(`${server.name} sign-in state does not match`)));
			}

			const code = queryParam(request, 'code');
			if (!code) {
				return $(Err(ApiErr.validationError(`${server.name} sign-in ended without a code: ${queryParam(request, 'error') ?? 'unknown'}`)));
			}

			const signIn = $(await exchangeMcpCode(server, {clientId: payload.clientId, redirectUri: redirectUri(appUrl), code, verifier: payload.verifier}));
			const account = $(await args.account(signIn));
			const encrypted = $(encryptSecret(JSON.stringify(signIn.credential)));

			const orgId = $(await requireUserOrgId(request));
			const existing = $(await listConnections(orgId)).find((connection) => connection.integrationId === integrationId && connection.account === account);
			if (existing) {
				$(await updateConnectionCredential({connectionId: existing.id, credential: encrypted}));
				return existing.id;
			}

			const row = $(await createConnection({orgId, integrationId, account, credential: encrypted, defaults: args.defaults}));
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

		const started = await Do<{cookie: string; url: string}, ApiError>(async ($) => {
			const clientId = $(await registerMcpClient(server, redirectUri(appUrl)));
			const state = randomBytes(16).toString('hex');
			const {verifier, challenge} = makePkce();
			const cookie = $(encryptSecret(JSON.stringify({state, verifier, clientId, userId: request.user.userId} satisfies StatePayload)));
			return {cookie, url: mcpAuthorizeUrl(server, {clientId, redirectUri: redirectUri(appUrl), state, challenge})};
		});
		if (started.isErr()) {
			redirectToConnectError(res, appUrl, started.error);
			return;
		}

		res.cookie(stateCookieName, started.value.cookie, {...stateCookieOptions(), maxAge: stateCookieMaxAgeMs});
		res.redirect(started.value.url);
	}

	/** `GET /api/connections/<integration>/callback` — where the sign-in comes back to; lands on the connection, saying it was added. */
	async function handleCallback(request: AuthenticatedRequest, res: Response): Promise<void> {
		const appUrl = env.APP_URL;
		if (!appUrl) {
			res.status(500).json({error: 'app_url_not_configured'});
			return;
		}

		// The handshake is single-use: cleared however the callback ends.
		res.clearCookie(stateCookieName, stateCookieOptions());
		const connectionId = await finishConnect(request, appUrl);
		if (connectionId.isErr()) {
			redirectToConnectError(res, appUrl, connectionId.error);
			return;
		}
		res.redirect(`${appUrl}/connections/${connectionId.value}?added`);
	}

	return {handleStart, handleCallback};
}
