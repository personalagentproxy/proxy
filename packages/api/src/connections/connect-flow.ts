import {createHash, randomBytes} from 'node:crypto';

import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseCookieHeader, requirePresent} from '@proxy/utils';
import {createConnection, findAccountConnection, renewConnection, updateConnectionName, updateConnectionTools, type ConnectionRow} from '@proxy/db/connection';
import type {IntegrationId, McpTool} from '@proxy/integrations';

import {queryParam, timingSafeEqualString, useSecureCookies} from '../auth/session';
import {log, serializeError} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {env} from '../utils/env';
import {encryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';
import {requireUserOrgId} from '../utils/user-org';

/**
 * Connecting an integration by signing in to it with OAuth and PKCE, as Granola, Notion and Linear
 * are through their MCP servers, and a custom MCP server found from its address. A sign-in begins
 * on the api, which keeps the handshake in a short-lived encrypted cookie, and the browser goes to
 * the provider's sign-in page: from the start route, a top-level navigation under
 * `/api/connections/<integration>`, for a provider known in advance (`signInRoutes`), or from the
 * answer of the route that found it, as a custom server's connect route (`signInFlow`). The
 * callback checks the provider's answer against the cookie, trades the code for tokens and makes
 * the connection, or gives an existing one of the same account its new tokens, which is how
 * signing in again works, and ends on the connection's page, or back on the catalog with
 * `?error=<integration>` (with `?error=<integration>-unconfigured` when the server lacks what the
 * sign-in needs, such as Google's client); a sign-in begun from the welcome flow (`returnTo: 'welcome'`) ends on its
 * page for the connection, or its catalog, instead, and one begun from a home page widget's card
 * (`returnTo: 'home'`) back on the home page. What the provider's sign-in page is and how a
 * code becomes tokens and a connection is the integration's.
 */

const stateCookieMaxAgeMs = 15 * 60 * 1000;

/** Where a sign-in ends when not on the connection's page: the welcome flow or the home page it began from. */
export const returnToSchema = z.enum(['welcome', 'home']);

type ReturnTo = z.infer<typeof returnToSchema>;

type Route = (request: AuthenticatedRequest, res: Response) => Promise<void>;

/**
 * What the provider's sign-in is sent: where it comes back to, the state, the PKCE challenge, and
 * the account a sign-in again is for (`?account=`), as a connection's page passes it, for a provider
 * that can open its sign-in on it.
 */
export type SignInRequest = {redirectUri: string; state: string; challenge: string; account: string | null};

/** The provider's sign-in page, and what to keep in the cookie for the callback. */
type SignInStart<E> = (request: SignInRequest) => Promise<Result<{url: string; kept: E}, ApiError>>;

/** The provider's answer coming back, with the verifier and what the start kept for it. */
type SignInAnswer<E> = {redirectUri: string; code: string; verifier: string; kept: E};

/**
 * A connection to save: the account it shows, the provider's own id for it where it gives one,
 * which stays as the account's address changes (Google's `sub`), its credential, stored encrypted,
 * the actions agents get with a new one, and a custom MCP server's tools and the name the person
 * gave it.
 */
export type Connected<C> = {account: string; accountId?: string; credential: C; defaults: string[]; tools?: McpTool[]; name?: string};

/** A PKCE verifier and the challenge the provider is sent in its place. */
function makePkce(): {verifier: string; challenge: string} {
	const verifier = randomBytes(32).toString('base64url');
	return {verifier, challenge: createHash('sha256').update(verifier).digest('base64url')};
}

/**
 * Saves a connection: a new one, or an existing one of the same account given the new credential
 * and the account as the provider names it now, such as an address changed since, and the tools
 * and the name, where it has its own; `added` unless it was already there.
 */
export function saveConnection<C>(orgId: string, integrationId: IntegrationId, connected: Connected<C>): Promise<Result<{row: ConnectionRow; added: boolean}, ApiError>> {
	return Do(async ($) => {
		const {account, tools} = connected;
		const encrypted = $(encryptSecret(JSON.stringify(connected.credential)));
		const providerAccountId = connected.accountId ?? null;
		const name = connected.name === undefined ? {} : {name: connected.name};
		const existing = $(await findAccountConnection({orgId, integrationId, account, providerAccountId}));
		if (!existing) {
			const listed = tools === undefined ? {} : {tools: JSON.stringify(tools)};
			return {row: $(await createConnection({orgId, integrationId, account, providerAccountId, credential: encrypted, defaults: connected.defaults, ...listed, ...name})), added: true};
		}
		$(await renewConnection({connectionId: existing.id, account, providerAccountId, credential: encrypted}));
		if (connected.name !== undefined) {
			$(await updateConnectionName({connectionId: existing.id, name: connected.name}));
		}
		if (tools === undefined) {
			return {row: {...existing, account, ...name}, added: false};
		}
		const stored = JSON.stringify(tools);
		$(await updateConnectionTools({connectionId: existing.id, tools: stored, actions: tools.map((tool) => tool.name)}));
		return {row: {...existing, account, tools: stored, ...name}, added: false};
	});
}

// Where the sign-in ends: the catalog, or the welcome flow's connections step it started from.
function catalogUrl(appUrl: string, returnTo: ReturnTo | undefined): string {
	if (returnTo === 'welcome') {
		return `${appUrl}/welcome/connections`;
	}
	return `${appUrl}/connections/new`;
}

type SignInArgs<E, C> = {
	integrationId: IntegrationId;
	// The provider's name in errors and logs: "Notion".
	name: string;
	// What the start keeps in the cookie for the callback beyond the handshake itself, such as the
	// client an MCP server registered for this sign-in.
	keptSchema: z.ZodType<E>;
	// The code traded for tokens, and the connection they make.
	finish: (answer: SignInAnswer<E>) => Promise<Result<Connected<C>, ApiError>>;
};

/**
 * The sign-in to one integration: `beginSignIn` for the route that knows the provider, and the
 * callback route.
 */
export function signInFlow<E, C>(args: SignInArgs<E, C>) {
	const {integrationId, name} = args;
	const stateCookieName = `proxy.${integrationId}-state`;
	// Only sent to these routes.
	const basePath = `/api/connections/${integrationId}`;
	const statePayloadSchema = z.object({state: z.string(), verifier: z.string(), userId: z.string(), returnTo: returnToSchema.optional(), kept: args.keptSchema});

	type StatePayload = {state: string; verifier: string; userId: string; returnTo?: ReturnTo; kept: E};

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
			return $(readStoredJson(stored, statePayloadSchema));
		});
	}

	function redirectToConnectError(res: Response, appUrl: string, returnTo: ReturnTo | undefined, error: ApiError): void {
		log.warn(`Connecting ${name} failed`, {kind: error.kind, ...('message' in error ? {message: error.message} : {}), ...('cause' in error ? serializeError(error.cause) : {})});
		res.redirect(`${catalogUrl(appUrl, returnTo)}?error=${integrationId}`);
	}

	/** Keeps the handshake, and what `start` keeps beside it, in a cookie on `res`, and answers the provider's sign-in page, for the browser to go to. */
	function beginSignIn(res: Response, begin: {userId: string; returnTo: ReturnTo | undefined; account: string | null; start: SignInStart<E>}): Promise<Result<string, ApiError>> {
		return Do(async ($) => {
			const appUrl = $(requirePresent(env.APP_URL, ApiErr.internalError(new Error('APP_URL is not configured'))));
			const state = randomBytes(16).toString('hex');
			const {verifier, challenge} = makePkce();
			const {url, kept} = $(await begin.start({redirectUri: redirectUri(appUrl), state, challenge, account: begin.account}));
			const payload: StatePayload = {state, verifier, userId: begin.userId, ...(begin.returnTo ? {returnTo: begin.returnTo} : {}), kept};
			const cookie = $(encryptSecret(JSON.stringify(payload)));
			res.cookie(stateCookieName, cookie, {...stateCookieOptions(), maxAge: stateCookieMaxAgeMs});
			return url;
		});
	}

	// The handshake the cookie holds, checked against the provider's answer, then the connection
	// made, or given its new tokens when it was already there.
	function finishConnect(request: AuthenticatedRequest, appUrl: string, payload: StatePayload): Promise<Result<{id: string; added: boolean}, ApiError>> {
		return Do(async ($) => {
			const state = queryParam(request, 'state') ?? '';
			if (!timingSafeEqualString(state, payload.state) || payload.userId !== request.user.userId) {
				return $(Err(ApiErr.validationError(`${name} sign-in state does not match`)));
			}

			const code = queryParam(request, 'code');
			if (!code) {
				return $(Err(ApiErr.validationError(`${name} sign-in ended without a code: ${queryParam(request, 'error') ?? 'unknown'}`)));
			}

			const connected = $(await args.finish({redirectUri: redirectUri(appUrl), code, verifier: payload.verifier, kept: payload.kept}));
			const orgId = $(await requireUserOrgId(request));
			const {row, added} = $(await saveConnection(orgId, integrationId, connected));
			return {id: row.id, added};
		});
	}

	/**
	 * `GET /api/connections/<integration>/callback` — where the sign-in comes back to; lands on the
	 * connection, saying it was added unless it was only signed in to again, or on the welcome
	 * flow's page for it when it started there.
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
		const finished = payload.isErr() ? Err(payload.error) : await finishConnect(request, appUrl, payload.value);
		if (finished.isErr()) {
			redirectToConnectError(res, appUrl, returnTo, finished.error);
			return;
		}
		const {id, added} = finished.value;
		if (returnTo === 'welcome') {
			res.redirect(`${appUrl}/welcome/connections/${id}`);
			return;
		}
		if (returnTo === 'home') {
			res.redirect(`${appUrl}/`);
			return;
		}
		res.redirect(`${appUrl}/connections/${id}${added ? '?added' : ''}`);
	}

	return {beginSignIn, handleCallback, redirectToConnectError};
}

/** The routes for a provider known in advance: the start, a top-level navigation, and the callback. */
export function signInRoutes<E, C>(
	args: SignInArgs<E, C> & {
		// Whether the server has what the sign-in needs, such as Google's client: without it, the
		// start goes back to the catalog saying so rather than trying.
		configured?: () => boolean;
		start: SignInStart<E>;
	},
): {handleStart: Route; handleCallback: Route} {
	const flow = signInFlow(args);

	/** `GET /api/connections/<integration>/start` — sends the browser to the provider's sign-in. */
	async function handleStart(request: AuthenticatedRequest, res: Response): Promise<void> {
		const appUrl = env.APP_URL;
		if (!appUrl) {
			res.status(500).json({error: 'app_url_not_configured'});
			return;
		}

		const returnTo = returnToSchema.safeParse(queryParam(request, 'returnTo')).data;
		if (args.configured && !args.configured()) {
			res.redirect(`${catalogUrl(appUrl, returnTo)}?error=${args.integrationId}-unconfigured`);
			return;
		}

		const begun = await flow.beginSignIn(res, {userId: request.user.userId, returnTo, account: queryParam(request, 'account'), start: args.start});
		if (begun.isErr()) {
			flow.redirectToConnectError(res, appUrl, returnTo, begun.error);
			return;
		}
		res.redirect(begun.value);
	}

	return {handleStart, handleCallback: flow.handleCallback};
}
