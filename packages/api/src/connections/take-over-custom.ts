import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {listCustomMcpConnections, takeOverConnection, type CustomMcpConnectionRow, type LockedCustomMcpConnection, type MovedConnection, type MovedRun} from '@proxy/db/connection';
import {findIntegration, TOOLS_COLLECTION_ID} from '@proxy/integrations';

import {worthRetrying} from '../data-migrations/retry';
import {log, serializeError} from '../observability/log';
import {encryptSecret} from '../utils/secret-crypto';
import {readStoredJson} from '../utils/stored-json';
import {builtInForHost} from './built-in-mcp';
import {customCredentialSchema, type CustomCredential} from './custom/custom-mcp';
import {keyInAddress, toolParamsSchema, type BuiltInMcp, type ToolParams} from './mcp/built-in';
import {accountOf, checkedKeyAccount} from './mcp/mcp-connect';
import {isExpiring, refreshMcpTokens, type McpCredential} from './mcp/mcp-oauth';
import type {McpKeyCredential} from './mcp/mcp-session';
import {callWithRefresh} from './token-session';

/**
 * Moving custom MCP connections over to the integration built in since on the same server, as a
 * data migration (`data-migrations/run.ts`): what was connected by address before becomes a
 * connection of the integration, keeping its id, its name and its activity. Its tools' settings
 * become the integration's actions, never allowing more than before, and its tool runs the
 * integration's requests. A sign-in to the server itself carries over, for the account it is for,
 * and a key the integration takes, typed in or in the address; otherwise the connection waits to be
 * signed in to (`needsSignIn`). A server reached with nothing at all stays custom. Done once per
 * connection, however many servers start at once (`takeOverConnection`), and tried again on the
 * next start where any failed.
 */

type Grant = {agentId: string; actionId: string; allowed: boolean};

const listedToolsSchema = z.array(z.object({name: z.string()}));

// The tools a custom connection's server last listed, by name.
function listedTools(tools: string | null): string[] {
	const json = Result.wrap((): unknown => JSON.parse(tools ?? '[]'));
	return json.isOk() ? (listedToolsSchema.safeParse(json.value).data ?? []).map((tool) => tool.name) : [];
}

/**
 * What a custom connection's settings become: an action is on, by default or for an agent, only
 * where every tool the server listed that was part of it was; one none of whose tools it listed is
 * off. An agent keeps a setting of its own only where it differs from the default.
 */
export function movedPermissions(builtIn: BuiltInMcp, actionIds: string[], connection: {listed: string[]; defaults: string[]; grants: Grant[]}): {defaults: string[]; grants: Grant[]} {
	const toolsOf = (actionId: string) => Object.keys(builtIn.tools).filter((name) => builtIn.tools[name]?.actions.includes(actionId) && connection.listed.includes(name));
	const allOn = (actionId: string, isOn: (tool: string) => boolean) => toolsOf(actionId).length > 0 && toolsOf(actionId).every(isOn);
	const defaults = actionIds.filter((actionId) => allOn(actionId, (tool) => connection.defaults.includes(tool)));
	const agentIds = [...new Set(connection.grants.map((grant) => grant.agentId))];
	const grants = agentIds.flatMap((agentId) => {
		const own = new Map(connection.grants.filter((grant) => grant.agentId === agentId).map((grant) => [grant.actionId, grant.allowed]));
		return actionIds.flatMap((actionId) => {
			const allowed = allOn(actionId, (tool) => own.get(tool) ?? connection.defaults.includes(tool));
			return allowed === defaults.includes(actionId) ? [] : [{agentId, actionId, allowed}];
		});
	});
	return {defaults, grants};
}

/** A tool run as the integration logs its own requests; null for a tool it has nothing for, which stays a tool run. */
export function movedRun(builtIn: BuiltInMcp, entry: {id: string; action: string; query: string | null}): MovedRun | null {
	const run = builtIn.tools[entry.action]?.run;
	if (!run) {
		return null;
	}
	// Params cut short in the log aren't JSON any more, and are left out.
	const json = Result.wrap((): unknown => JSON.parse(entry.query ?? 'null'));
	const params: ToolParams = json.isOk() ? (toolParamsSchema.safeParse(json.value).data ?? null) : null;
	const moved = run(params);
	return {id: entry.id, collectionId: moved.collectionId, action: moved.operation, recordTitle: moved.title ?? null, query: moved.query ?? null};
}

// The address without its query, as the server's own is written.
function serverAddress(url: string): string | null {
	return URL.canParse(url) ? `${new URL(url).origin}${new URL(url).pathname.replace(/\/$/, '')}` : null;
}

type Carried = McpCredential | McpKeyCredential;

type MovedCredential = {kind: 'moved'; credential: Carried | null} | {kind: 'stays'};

/**
 * What a custom connection's credential becomes as the integration keeps one (`moved`): a sign-in
 * to the integration's own server, through its own authorization server, or a key the integration
 * takes, typed in as a bare token or carried in the address (`keyInAddress`); null for anything
 * else, which has to be signed in to again. A server reached with nothing at all, as Parallel's
 * keyless one is, can't be reached so by the integration, so the connection stays custom
 * (`stays`) rather than stop working.
 */
export function movedCredential(builtIn: BuiltInMcp, custom: CustomCredential | null): MovedCredential {
	if (custom === null) {
		return {kind: 'moved', credential: null};
	}
	const inAddress = URL.canParse(custom.url) ? keyInAddress(builtIn, new URL(custom.url)) : null;
	if (inAddress) {
		return {kind: 'moved', credential: {auth: 'key', key: inAddress}};
	}
	if (custom.auth === 'none') {
		return {kind: 'stays'};
	}
	if (custom.auth === 'token') {
		const bare = builtIn.apiKey && !/\s/.test(custom.token);
		return {kind: 'moved', credential: bare ? {auth: 'key', key: custom.token} : null};
	}
	if (serverAddress(custom.url) !== serverAddress(builtIn.server.url) || custom.server.tokenUrl !== builtIn.server.tokenUrl) {
		return {kind: 'moved', credential: null};
	}
	const {clientId, accessToken, refreshToken, expiresAt} = custom;
	return {kind: 'moved', credential: {clientId, accessToken, refreshToken, expiresAt}};
}

// Nothing carried over: the server's address as the account, until it is signed in to.
function unsignedIn(address: string): {account: string; credential: null} {
	return {account: address, credential: null};
}

/**
 * The account as signing in again or connecting with the key would find it, and the credential to
 * keep: a key is checked with the server, as connecting with one is, and a sign-in's tokens are
 * refreshed where they ran out, or the provider turns them down, as using them would be
 * (`callWithRefresh`), the new ones kept (`keep`) before anything else is asked, since the
 * provider may take back the refresh token they replace. A credential the provider turns down
 * carries nothing over; any other failure is an error, the move tried again on the next start, so
 * the account is never left one a later sign-in wouldn't find.
 */
export function movedAccount(
	builtIn: BuiltInMcp,
	credential: Carried | null,
	address: string,
	keep: (tokens: McpCredential) => Promise<Result<void, ApiError>>,
): Promise<Result<{account: string; credential: Carried | null}, ApiError>> {
	return Do(async ($) => {
		if (!credential) {
			return unsignedIn(address);
		}
		const named: Result<{account: string; credential: Carried}, ApiError> =
			'key' in credential
				? (await checkedKeyAccount(builtIn, credential.key)).map(({account}) => ({account, credential}))
				: await callWithRefresh(
						{
							isExpiring,
							refresh: (tokens) =>
								Do<McpCredential, ApiError>(async ($$) => {
									const refreshed = $$(await refreshMcpTokens(builtIn.server, tokens));
									$$(await keep(refreshed));
									return refreshed;
								}),
						},
						credential,
						async (tokens) => (await accountOf(builtIn, tokens.accessToken)).map(({account}) => ({account, credential: tokens})),
					);
		if (named.isErr() && named.error.kind === 'credentials_rejected') {
			return unsignedIn(address);
		}
		return $(named);
	});
}

/** Moves one custom connection over; `Ok(false)` when another server already did, or it stays custom. */
export function takeOver(connection: CustomMcpConnectionRow, builtIn: BuiltInMcp): Promise<Result<boolean, ApiError>> {
	return Do(async ($) => {
		const integration = $(requirePresent(findIntegration(builtIn.integrationId), ApiErr.internalError(new Error(`No integration ${builtIn.integrationId}`))));
		const actionIds = integration.actions.map((action) => action.id);
		// Everything from the connection as it is once locked, so two servers starting at once don't
		// both refresh its tokens, and a request that refreshed them meanwhile isn't undone. It asks
		// nothing of the database, which the lock holds a connection of, but keeps refreshed tokens on
		// the custom connection as it was, so a failed move loses none. A credential that can't be
		// read, as after a change of `ENCRYPTION_KEY`, is an error, the connection left custom, which
		// it works as still.
		const move = (locked: LockedCustomMcpConnection, keepCredential: (credential: string) => Promise<Result<void, ApiError>>) =>
			Do<MovedConnection | null, ApiError>(async ($$) => {
				const custom = locked.credential === null ? null : $$(readStoredJson(locked.credential, customCredentialSchema));
				const carried = movedCredential(builtIn, custom);
				if (carried.kind === 'stays') {
					return null;
				}
				const permissions = movedPermissions(builtIn, actionIds, {
					listed: listedTools(locked.tools),
					defaults: locked.defaults.map((stored) => stored.actionId),
					grants: locked.agentGrants,
				});
				const runs = locked.runs.flatMap((entry) => movedRun(builtIn, entry) ?? []);
				const keep = (tokens: McpCredential) => Do<void, ApiError>(async ($k) => $k(await keepCredential($k(encryptSecret(JSON.stringify({...custom, ...tokens}))))));
				const {account, credential} = $$(await movedAccount(builtIn, carried.credential, locked.account, keep));
				const encrypted = credential ? $$(encryptSecret(JSON.stringify(credential))) : null;
				return {integrationId: builtIn.integrationId, account, credential: encrypted, ...permissions, runs};
			});
		return $(await takeOverConnection(connection.id, TOOLS_COLLECTION_ID, move));
	});
}

/**
 * Moves every custom MCP connection an integration takes over, logging each; an error when listing
 * them failed, or moving any did for a reason the next start might not meet (`worthRetrying`), so
 * the data migration is tried again then. One that can't be moved over stays custom, logged.
 */
export async function takeOverCustomConnections(): Promise<Result<void, ApiError>> {
	const connections = await listCustomMcpConnections();
	if (connections.isErr()) {
		log.error('Listing custom MCP connections to move over failed', 'cause' in connections.error ? serializeError(connections.error.cause) : {kind: connections.error.kind});
		return Err(connections.error);
	}
	let failed = 0;
	for (const connection of connections.value) {
		// A custom connection's account is its server's address, host first: "mcp.linear.app/mcp".
		const builtIn = builtInForHost(connection.account.split('/')[0] ?? '');
		if (!builtIn) {
			continue;
		}
		const moved = await takeOver(connection, builtIn);
		if (moved.isErr()) {
			const details = {
				connectionId: connection.id,
				integrationId: builtIn.integrationId,
				kind: moved.error.kind,
				...('cause' in moved.error ? serializeError(moved.error.cause) : {}),
			};
			if (!worthRetrying(moved.error)) {
				log.error('A custom MCP connection can’t be moved over, and stays custom', details);
				continue;
			}
			failed += 1;
			log.warn('Moving a custom MCP connection over failed, to be tried again on the next start', details);
			continue;
		}
		if (moved.value) {
			log.info('Moved a custom MCP connection over', {connectionId: connection.id, integrationId: builtIn.integrationId});
		}
	}
	if (failed > 0) {
		return Err(ApiErr.internalError(new Error(`Moving ${failed} custom MCP connections over failed`)));
	}
	return Ok(undefined);
}
