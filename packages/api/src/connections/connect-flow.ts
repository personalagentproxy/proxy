import {createHash, randomBytes} from 'node:crypto';

import type {Response} from 'express';
import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseCookieHeader, requirePresent} from '@proxy/utils';
import {
	createConnection,
	findAccountConnection,
	getConnectionWithCredential,
	renewConnection,
	updateConnectionName,
	updateConnectionTools,
	type ConnectionRow,
	type MemberViewer,
} from '@proxy/db/connection';
import {getMembership} from '@proxy/db/organization';
import type {IntegrationId, McpTool} from '@proxy/integrations';

import {queryParam, timingSafeEqualString, useSecureCookies} from '../auth/session';
import {log, serializeError} from '../observability/log';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {env} from '../utils/env';
import {encryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';
import {requireViewer} from '../utils/user-org';
import {manages, requireManaged} from './managed';
import {ownership} from './ownership';

/**
 * Connecting an integration by signing in to it with OAuth and PKCE, as Granola, Notion and Linear
 * are through their MCP servers, and a custom MCP server found from its address. A sign-in begins
 * on the api, which keeps the handshake in a short-lived encrypted cookie, and the browser goes to
 * the provider's sign-in page: from the start route, a top-level navigation under
 * `/api/connections/<integration>`, for a provider known in advance (`signInRoutes`), or from the
 * answer of the route that found it, as a custom server's connect route (`signInFlow`). The
 * callback checks the provider's answer against the cookie, trades the code for tokens and makes
 * the connection, in the organization the sign-in began in, the person's own or, `?share=everyone`,
 * every member's, or gives an existing one its new tokens, which is how signing in again works:
 * the one of the same account among those the person may change, or, where the account can't be
 * told apart (`connectionToRenew`), the one the sign-in was begun from (`?connection=`), as a
 * connection's page begins it, so only that page renews it. The callback ends on the connection's page, or back on the catalog with
 * `?error=<integration>` (with `?error=<integration>-unconfigured` when the server lacks what the
 * sign-in needs, such as Google's client); a sign-in begun from the welcome flow
 * (`returnTo: 'welcome'`) ends on its page for the connection, or its catalog, instead, and one
 * begun from a home page widget's card (`returnTo: 'home'`) back on the home page. What the
 * provider's sign-in page is and how a code becomes tokens and a connection is the integration's.
 */

const stateCookieMaxAgeMs = 15 * 60 * 1000;

/** Where a sign-in ends when not on the connection's page: the welcome flow or the home page it began from. */
export const returnToSchema = z.enum(['welcome', 'home']);

export type ReturnTo = z.infer<typeof returnToSchema>;

type Route = (request: AuthenticatedRequest, res: Response) => Promise<void>;

/** What a connection the person names is called, as the custom MCP form's is. */
export const connectionNameSchema = z.string().trim().min(1, 'Give the connection a name').max(80, 'The name can be at most 80 characters');

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
 * the actions agents get with a new one, a custom MCP server's tools, and the name the person gave
 * it: a new connection's, or, for a custom server added again, the connection's new name; any other
 * connection renewed keeps its own. `anonymous` where the provider said nothing of who signed in,
 * as Exa and Parallel don't: the account is only a label, so no existing connection is the same
 * account's.
 */
export type Connected<C> = {account: string; accountId?: string; credential: C; defaults: string[]; tools?: McpTool[]; name?: string; anonymous?: true};

/** A PKCE verifier and the challenge the provider is sent in its place. */
function makePkce(): {verifier: string; challenge: string} {
	const verifier = randomBytes(32).toString('base64url');
	return {verifier, challenge: createHash('sha256').update(verifier).digest('base64url')};
}

// The one of the same account among those the viewer sees and may change, if there is one: a
// sign-in to another account is a connection of its own, never one agents were given for the first,
// and another member's own connection of the account, or a shared one they only use, is theirs to
// renew, so the sign-in makes a new connection beside it. A sign-in begun from a connection
// (`?connection=`) renews that one, while it is still the integration's and the viewer's to change,
// only where its account can't be told apart from another's: the provider said nothing of who
// signed in (`anonymous`), or the connection was never signed in to, as one moved over from a
// custom MCP server without a sign-in of the integration's (`take-over-custom.ts`), and no other
// connection is the account's already, so an account is never connected twice.
function connectionToRenew(
	viewer: MemberViewer,
	integrationId: IntegrationId,
	connected: {account: string; providerAccountId: string | null; anonymous: boolean},
	connectionId: string | null,
): Promise<Result<ConnectionRow | null, ApiError>> {
	return Do(async ($) => {
		const {account, providerAccountId} = connected;
		const sameAccount = connected.anonymous ? null : $(await findAccountConnection(viewer, {integrationId, account, providerAccountId}));
		if (sameAccount && $(await manages(viewer, sameAccount))) {
			return sameAccount;
		}
		const begunFrom = connectionId === null ? null : $(await getConnectionWithCredential(viewer, connectionId));
		if (begunFrom?.integrationId !== integrationId || !$(await manages(viewer, begunFrom))) {
			return null;
		}
		if (!connected.anonymous && begunFrom.credential !== null) {
			return null;
		}
		const {credential: _credential, ...row} = begunFrom;
		return row;
	});
}

/** How a connection is saved: `shared` with every member of the organization rather than the viewer's own, and the connection a sign-in was begun from, to renew (`connectionToRenew`). */
export type SaveOptions = {shared?: boolean; connectionId?: string | null};

/**
 * Saves a connection: a new one, the viewer's own or every member's (`shared`), or an existing one
 * (`connectionToRenew`), given the new credential and the account as the provider names it now,
 * such as an address changed since, and, for a custom server, its tools and the name; `added`
 * unless it was already there.
 */
export function saveConnection<C>(
	viewer: MemberViewer,
	integrationId: IntegrationId,
	connected: Connected<C>,
	options: SaveOptions = {},
): Promise<Result<{row: ConnectionRow; added: boolean}, ApiError>> {
	return Do(async ($) => {
		const {account, tools} = connected;
		const encrypted = $(encryptSecret(JSON.stringify(connected.credential)));
		const providerAccountId = connected.accountId ?? null;
		const name = connected.name === undefined ? {} : {name: connected.name};
		const existing = $(await connectionToRenew(viewer, integrationId, {account, providerAccountId, anonymous: connected.anonymous === true}, options.connectionId ?? null));
		if (!existing) {
			const listed = tools === undefined ? {} : {tools: JSON.stringify(tools)};
			return {
				row: $(
					await createConnection({...ownership(viewer, options.shared === true), integrationId, account, providerAccountId, credential: encrypted, defaults: connected.defaults, ...listed, ...name}),
				),
				added: true,
			};
		}
		$(await renewConnection({connectionId: existing.id, account, providerAccountId, credential: encrypted}));
		if (tools === undefined) {
			return {row: {...existing, account}, added: false};
		}
		// A custom server added again is the same connection, with the server's tools as it lists
		// them now and the name the person gave it this time.
		if (connected.name !== undefined) {
			$(await updateConnectionName({connectionId: existing.id, name: connected.name}));
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
	// `orgId`: the organization it began in, where the connection is made, whichever is open when it
	// comes back. `shared`: the connection is for every member of it rather than the person's own.
	// `connectionId`: the connection it was begun from, to renew.
	const statePayloadSchema = z.object({
		state: z.string(),
		verifier: z.string(),
		userId: z.string(),
		orgId: z.string(),
		returnTo: returnToSchema.optional(),
		shared: z.boolean().optional(),
		connectionId: z.string().optional(),
		kept: args.keptSchema,
	});

	type StatePayload = {state: string; verifier: string; userId: string; orgId: string; returnTo?: ReturnTo; shared?: boolean; connectionId?: string; kept: E};

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

	/**
	 * Keeps the handshake, and what `start` keeps beside it, in a cookie on `res`, and answers the
	 * provider's sign-in page, for the browser to go to: for a connection of the viewer's own, or
	 * `shared` with every member, or renewing the one it was begun from (`connectionId`).
	 */
	function beginSignIn(
		res: Response,
		begin: {viewer: MemberViewer; returnTo: ReturnTo | undefined; account: string | null; shared?: boolean; connectionId?: string | null; start: SignInStart<E>},
	): Promise<Result<string, ApiError>> {
		return Do(async ($) => {
			const appUrl = $(requirePresent(env.APP_URL, ApiErr.internalError(new Error('APP_URL is not configured'))));
			const state = randomBytes(16).toString('hex');
			const {verifier, challenge} = makePkce();
			const {url, kept} = $(await begin.start({redirectUri: redirectUri(appUrl), state, challenge, account: begin.account}));
			const payload: StatePayload = {
				state,
				verifier,
				userId: begin.viewer.userId,
				orgId: begin.viewer.orgId,
				...(begin.returnTo ? {returnTo: begin.returnTo} : {}),
				...(begin.shared ? {shared: true} : {}),
				...(begin.connectionId ? {connectionId: begin.connectionId} : {}),
				kept,
			};
			const cookie = $(encryptSecret(JSON.stringify(payload)));
			res.cookie(stateCookieName, cookie, {...stateCookieOptions(), maxAge: stateCookieMaxAgeMs});
			return url;
		});
	}

	// The handshake the cookie holds, checked against the provider's answer, then the connection
	// made in the organization it began in, while the person is still in it, or given its new tokens
	// when it was already there.
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

			const viewer = {orgId: payload.orgId, userId: payload.userId};
			$(requirePresent($(await getMembership(viewer.userId, viewer.orgId)), ApiErr.notFound('organization', viewer.orgId)));
			const connected = $(await args.finish({redirectUri: redirectUri(appUrl), code, verifier: payload.verifier, kept: payload.kept}));
			const {row, added} = $(await saveConnection(viewer, integrationId, connected, {shared: payload.shared, connectionId: payload.connectionId ?? null}));
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

		// `?share=everyone` connects it for every member of the organization; `?connection=` renews one
		// of the integration's connections the person may change.
		const begun = await Do<string, ApiError>(async ($) => {
			const viewer = $(await requireViewer(request));
			const connectionId = queryParam(request, 'connection');
			if (connectionId !== null) {
				$(await requireManaged(viewer, connectionId));
			}
			return $(await flow.beginSignIn(res, {viewer, returnTo, account: queryParam(request, 'account'), shared: queryParam(request, 'share') === 'everyone', connectionId, start: args.start}));
		});
		if (begun.isErr()) {
			flow.redirectToConnectError(res, appUrl, returnTo, begun.error);
			return;
		}
		res.redirect(begun.value);
	}

	return {handleStart, handleCallback: flow.handleCallback};
}
