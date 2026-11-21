import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {type ConnectionRow, updateConnectionTools} from '@proxy/db/connection';
import {findTool} from '@proxy/integrations';

import {log} from '../../observability/log';
import type {LoadedConnection} from '../../records/target';
import {integrationOf} from '../../utils/connection-actions';
import {noteRejectedSignIn} from '../rejected-sign-in';
import {needsSignIn} from '../unavailable';
import {listCustomTools} from './custom-mcp';

/**
 * A custom MCP server's tools as its connection keeps them, asked for again for agents, as the
 * person does from the connection's page (route.ts): by an agent itself (`pap.refreshTools`); by
 * an agent reading them once the list is an hour old; and, at most once a minute, by a call naming
 * a tool the list lacks, or one the server says it doesn't have, since a server adds and takes away
 * tools without telling anyone. The new list replaces
 * the old as the page's does: what agents may do with a tool the server no longer lists is dropped,
 * and one it lists now is off until the person turns it on.
 *
 * When each connection was last asked is kept by this instance alone, so another instance, or this
 * one once restarted, may ask again sooner; asking is cheap and changes nothing when the list is
 * the same. A connection asked for twice at once is asked once.
 */

/** How old a connection's tools may be before an agent reading them has the server asked again. */
const TOOLS_MAX_AGE_MS = 60 * 60 * 1000;

/** How soon after the server was last asked a call naming a tool it lacks may ask again. */
const MISSING_TOOL_RETRY_MS = 60 * 1000;

const CUSTOM_MCP = 'mcp';

type StoredConnection = ConnectionRow & {credential: string | null};

// When this instance last asked each connection's server, whatever it answered, so a server that
// is down isn't asked again on every read.
const askedAt = new Map<string, number>();

// The asking under way for each connection, which a second ask waits for.
const asking = new Map<string, Promise<Result<LoadedConnection, ApiError>>>();

/** Whether the connection is a custom MCP server's, whose tools can be asked for again. */
export function listsOwnTools(connection: Pick<ConnectionRow, 'integrationId'>): boolean {
	return connection.integrationId === CUSTOM_MCP;
}

// Asks the server for its tools and keeps them, the connection given back with them; a sign-in the
// server turns down is noted on the connection, as a tool run's is.
function askAndKeep(connection: StoredConnection): Promise<Result<LoadedConnection, ApiError>> {
	return Do(async ($) => {
		askedAt.set(connection.id, Date.now());
		const tools = $(await noteRejectedSignIn(connection, connection.credential, await listCustomTools(connection)));
		const stored = JSON.stringify(tools);
		$(await updateConnectionTools({connectionId: connection.id, tools: stored, actions: tools.map((tool) => tool.name)}));
		const refreshed = {...connection, tools: stored};
		const integration = $(requirePresent(integrationOf(refreshed), ApiErr.notFound('connection', connection.id)));
		return {connection: refreshed, integration};
	});
}

/**
 * Asks a custom MCP server for its tools now and keeps the new list, the connection given back with
 * its integration built from it. The caller checks it is one (`listsOwnTools`).
 */
export function refreshCustomTools(connection: StoredConnection): Promise<Result<LoadedConnection, ApiError>> {
	const running = asking.get(connection.id);
	if (running) {
		return running;
	}
	const started = askAndKeep(connection).finally(() => asking.delete(connection.id));
	asking.set(connection.id, started);
	return started;
}

// The connection with its tools asked for again where the server was last asked longer than
// `maxAgeMs` ago, by this instance; as it was where it isn't a custom server's, needs signing in
// to again, or asking fails, which is logged: the kept list is still the best there is.
async function refreshedIfOlder(loaded: LoadedConnection, maxAgeMs: number): Promise<LoadedConnection> {
	const {connection} = loaded;
	if (!listsOwnTools(connection) || needsSignIn(connection)) {
		return loaded;
	}
	const last = askedAt.get(connection.id);
	if (last !== undefined && Date.now() - last < maxAgeMs) {
		return loaded;
	}
	const refreshed = await refreshCustomTools(connection);
	if (refreshed.isErr()) {
		log.warn('A custom MCP server’s tools could not be asked for again', {connectionId: connection.id, errorKind: refreshed.error.kind});
		return loaded;
	}
	return refreshed.value;
}

/** The connection, with a custom server's tools asked for again where the list is older than an hour. */
export function withFreshTools(loaded: LoadedConnection): Promise<LoadedConnection> {
	return refreshedIfOlder(loaded, TOOLS_MAX_AGE_MS);
}

/**
 * The connection, with a custom server's tools asked for again where they lack `toolName` and the
 * server wasn't asked in the last minute, so a tool it added since is found.
 */
export function withToolListed(loaded: LoadedConnection, toolName: string): Promise<LoadedConnection> {
	if (findTool(loaded.integration, toolName)) {
		return Promise.resolve(loaded);
	}
	return refreshedIfOlder(loaded, MISSING_TOOL_RETRY_MS);
}

// Whether a tool's failure is the server saying it has no such tool: the MCP spec's code for it,
// Invalid params, or words naming the tool as unknown or not found. A failure taken for one wrongly
// only has the server asked again, once a minute at most, and is answered as it was.
function saysToolIsGone(error: ApiError, toolName: string): boolean {
	const said = 'message' in error ? (error.message ?? '') : '';
	if (said.includes('-32602')) {
		return true;
	}
	return said.includes(toolName) && /\b(not found|unknown|no such)\b/i.test(said);
}

/**
 * What a custom server's tool answered, but not found where the server said it has no such tool
 * and, asked for its tools again, no longer lists it, so the agent is told as for any tool the list
 * lacks. Any other answer is passed on as it was.
 */
export async function unlessToolGone<T>(loaded: LoadedConnection, toolName: string, answer: Result<T, ApiError>): Promise<Result<T, ApiError>> {
	if (answer.isOk() || !saysToolIsGone(answer.error, toolName)) {
		return answer;
	}
	const refreshed = await refreshedIfOlder(loaded, MISSING_TOOL_RETRY_MS);
	if (findTool(refreshed.integration, toolName)) {
		return answer;
	}
	return Err(ApiErr.notFound('tool', toolName));
}

/** Forgets when each server was asked, for tests. */
export function forgetAskedForTests(): void {
	askedAt.clear();
	asking.clear();
}
