import type {Response} from 'express';
import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import type {ConnectionRow, MemberViewer} from '@proxy/db/connection';

import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {requireViewer} from '../../utils/user-org';
import {respond, type ConnectionResponse} from '../connection-response';
import {saveConnection, signInFlow, signInRoutes, type Connected, type ReturnTo, type SaveOptions, type SignInRequest} from '../connect-flow';
import {requireManaged} from '../managed';
import {shareBodySchema} from '../ownership';
import type {BuiltInMcp, ProviderAccount} from './built-in';
import {exchangeMcpCode, mcpAuthorizeUrl, registerMcpClient, type McpCredential, type McpServer} from './mcp-oauth';
import type {McpKeyCredential} from './mcp-session';

/**
 * Connecting an integration built on its MCP server: by signing in to it, as Granola, Notion and
 * Linear are and as a custom server found from its address is (`custom/route.ts`), or with an API
 * key where the server takes one, as Exa's and Parallel's do. A sign-in registers a client with the
 * server's authorization server and sends the browser to its sign-in page; a key is checked with
 * the server, then kept as the connection's credential, sent as its bearer token.
 */

/** Registers a client for this sign-in and answers the server's sign-in page, the client kept for the callback beside `kept`. */
export function startMcpSignIn<K extends object>(server: McpServer, {redirectUri, state, challenge}: SignInRequest, kept: K): Promise<Result<{url: string; kept: K & {clientId: string}}, ApiError>> {
	return Do(async ($) => {
		const clientId = $(await registerMcpClient(server, redirectUri));
		return {url: mcpAuthorizeUrl(server, {clientId, redirectUri, state, challenge}), kept: {...kept, clientId}};
	});
}

/** What a connection shows as its account: as the provider names it, or that it was signed in to, where the provider says nothing of who did. */
export function accountOf(builtIn: BuiltInMcp, accessToken: string): Promise<Result<ProviderAccount, ApiError>> {
	if (!builtIn.account) {
		return Promise.resolve(Ok({account: SIGNED_IN}));
	}
	return builtIn.account(accessToken);
}

// A connection of a provider that says nothing of who signed in can't be told to be the same
// account's as another: only the one a sign-in was begun from is renewed (`Connected.anonymous`).
function anonymity(builtIn: BuiltInMcp): {anonymous?: true} {
	return builtIn.account ? {} : {anonymous: true};
}

const SIGNED_IN = 'Signed in';

const keptSchema = z.object({clientId: z.string(), name: z.string().optional()});

type Kept = z.infer<typeof keptSchema>;

// The sign-in to an integration built on its MCP server, keeping the name the person gave the
// connection where it began on the custom MCP form.
function builtInSignIn(builtIn: BuiltInMcp) {
	const {server} = builtIn;
	return {
		integrationId: builtIn.integrationId,
		name: server.name,
		keptSchema,
		start: (request: SignInRequest) => startMcpSignIn(server, request, {}),
		finish: ({redirectUri, code, verifier, kept}: {redirectUri: string; code: string; verifier: string; kept: Kept}) =>
			Do<Connected<McpCredential>, ApiError>(async ($) => {
				const credential = $(await exchangeMcpCode(server, {clientId: kept.clientId, redirectUri, code, verifier}));
				const account = $(await accountOf(builtIn, credential.accessToken));
				return {...account, credential, defaults: builtIn.defaults, ...anonymity(builtIn), ...(kept.name ? {name: kept.name} : {})};
			}),
	};
}

/**
 * The routes for an integration built on its MCP server, as Granola's is: the start, a top-level
 * navigation, and the callback, which makes the connection for the account the sign-in is for.
 */
export function mcpConnectRoutes(builtIn: BuiltInMcp) {
	return signInRoutes(builtInSignIn(builtIn));
}

/**
 * Begins the sign-in to an integration built on its MCP server from the custom MCP form, given the
 * integration's own server, the connection called `name`, the viewer's own or `shared`; its sign-in
 * page, for the browser to go to, which comes back to the integration's callback.
 */
export function beginBuiltInSignIn(
	builtIn: BuiltInMcp,
	res: Response,
	begin: {viewer: MemberViewer; returnTo: ReturnTo | undefined; name: string; shared: boolean},
): Promise<Result<string, ApiError>> {
	return signInFlow(builtInSignIn(builtIn)).beginSignIn(res, {
		viewer: begin.viewer,
		returnTo: begin.returnTo,
		account: null,
		shared: begin.shared,
		start: (request) => startMcpSignIn(builtIn.server, request, {name: begin.name}),
	});
}

/** What a connection made with an API key shows as its account where the provider names none: the key's end, as the provider's own list of keys shows it. */
export function keyAccount(key: string): string {
	return `API key ending ${key.slice(-4)}`;
}

/** The account a key is for, as the provider names it, else the key's end. */
export function keyAccountOf(builtIn: BuiltInMcp, key: string): Promise<Result<ProviderAccount, ApiError>> {
	if (!builtIn.account) {
		return Promise.resolve(Ok({account: keyAccount(key)}));
	}
	return builtIn.account(key);
}

/**
 * The account a key is for, checked with the server first, as the provider names it, else the key's
 * end. A key the server turns down is `credentials_rejected`; one for an integration that takes
 * none is refused.
 */
export function checkedKeyAccount(builtIn: BuiltInMcp, key: string): Promise<Result<ProviderAccount, ApiError>> {
	return Do(async ($) => {
		const apiKey = $(requirePresent(builtIn.apiKey, ApiErr.validationError(`${builtIn.server.name} is connected by signing in to it`)));
		$(await apiKey.check(key));
		return $(await keyAccountOf(builtIn, key));
	});
}

/**
 * Connects an integration with an API key, checked with the server first: a new connection, called
 * `name` where the custom MCP form gave one, the viewer's own or `shared`, or an existing one given
 * the key in place of its sign-in or key, its name kept: the one of the key's account, or
 * `connectionId` where its account can't be told apart from another's (`saveConnection`). A key the
 * server turns down is `credentials_rejected`.
 */
export function connectWithKey(builtIn: BuiltInMcp, viewer: MemberViewer, args: {name?: string; key: string} & SaveOptions): Promise<Result<ConnectionRow & {credential: string}, ApiError>> {
	return Do(async ($) => {
		if (/\s/.test(args.key)) {
			return $(Err(ApiErr.validationError('An API key has no spaces')));
		}
		const account = $(await checkedKeyAccount(builtIn, args.key));
		const credential: McpKeyCredential = {auth: 'key', key: args.key};
		const connected = {...account, credential, defaults: builtIn.defaults, ...anonymity(builtIn), ...(args.name === undefined ? {} : {name: args.name})};
		const {row} = $(await saveConnection(viewer, builtIn.integrationId, connected, {shared: args.shared, connectionId: args.connectionId}));
		// A key opens all of the integration: how the response reads the credential, which never leaves the api.
		return {...row, credential: JSON.stringify(credential)};
	});
}

const keyBodySchema = z
	.object({
		key: z.string().trim().min(1, 'Paste the API key').max(1000, 'That is too long for an API key'),
		// The connection to give the key, as its page does; else a new one.
		connection: z.string().optional(),
	})
	.extend(shareBodySchema.shape);

/**
 * `POST /api/connections/<integration>` with `{key, connection?, shared?}`: connects the
 * integration with an API key; the new connection, the person's own or every member's, or the one
 * given the key, which the person may change. 422 is a key the server turned down, 502 the server
 * out of reach.
 */
export function keyConnectRoute(builtIn: BuiltInMcp): (request: AuthenticatedRequest) => Promise<Result<ConnectionResponse, ApiError>> {
	return (request) =>
		Do(async ($) => {
			const body = $(parseSchema(keyBodySchema, request.body));
			const viewer = $(await requireViewer(request));
			if (body.connection !== undefined) {
				$(await requireManaged(viewer, body.connection));
			}
			const row = $(await connectWithKey(builtIn, viewer, {key: body.key, connectionId: body.connection ?? null, shared: body.shared}));
			return $(await respond(row));
		});
}
