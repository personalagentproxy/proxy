import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {logAgentRequest} from '@proxy/db/audit';
import {API_REQUESTS_ID, GIT_REQUESTS_ID} from '@proxy/integrations';

import {type Outcome, recordToolCall} from '../../agent-side/tools';
import type {CliCaller} from '../authenticate';
import type {Operation} from './graphql';
import type {PushedRef} from './pkt-line';

/**
 * The activity log's entries for requests relayed to GitHub (route.ts), written as every tool run's
 * are, under the token's task, coming in as `cli`, with the same metrics. The collection is git's
 * or the API's (@proxy/integrations' relayed requests), the action the connection's action the
 * request needed, the record title the repository it names, and the query what was done: a push's
 * refs, an API request's method and path, with a GraphQL operation's type and name. Never the
 * query string, the body beyond that, or anything of the token.
 */

/** What an entry says of a request. */
export type GitHubEntry = {collection: typeof GIT_REQUESTS_ID | typeof API_REQUESTS_ID; action: string; repository: string | null; query: string | null};

// How much of an entry's query is kept: a push of many refs is cut short.
const MAX_QUERY = 200;

function cut(text: string): string {
	return text.length <= MAX_QUERY ? text : `${text.slice(0, MAX_QUERY - 1)}…`;
}

// A ref as people say it: a branch by its name, anything else as it is.
function refName({ref, deleted}: PushedRef): string {
	const name = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
	return deleted ? `${name} (deleted)` : name;
}

/** A push's query: the refs it updates, "fix-login, refs/tags/v1.2", and "…" where the peek didn't reach them all; null where it read none. */
export function pushQuery(refs: PushedRef[], complete: boolean): string | null {
	if (refs.length === 0) {
		return null;
	}
	return cut(`${refs.map(refName).join(', ')}${complete ? '' : ', …'}`);
}

/** An API request's query: "POST /repos/acme/demo/pulls", and a GraphQL one's operation, "POST /graphql mutation CreatePullRequest". */
export function apiQuery(method: string, path: string, operation: Operation | null | undefined): string {
	if (operation === undefined) {
		return cut(`${method} ${path}`);
	}
	if (operation === null) {
		return cut(`${method} ${path} (operation unclear)`);
	}
	return cut(`${method} ${path} ${operation.type}${operation.name ? ` ${operation.name}` : ''}`);
}

/** Logs one request relayed to GitHub, or refused, `error` what went wrong with a failed one. */
export function logGitHubRequest(
	caller: CliCaller,
	connection: {id: string; integrationId: string},
	entry: GitHubEntry,
	outcome: Outcome,
	startedAt: number,
	error?: string,
): Promise<Result<void, ApiError>> {
	const taskCaller = {agent: caller.agent, via: 'cli', taskId: caller.taskId} as const;
	recordToolCall(taskCaller, connection, entry.action, outcome, startedAt, error);
	return logAgentRequest({
		orgId: caller.agent.orgId,
		agentId: caller.agent.agentId,
		connectionId: connection.id,
		collectionId: entry.collection,
		action: entry.action,
		recordTitle: entry.repository,
		query: entry.query,
		outcome,
		via: 'cli',
		taskId: caller.taskId,
		ownerUserId: caller.agent.ownerUserId,
		startedAt,
		error,
	});
}
