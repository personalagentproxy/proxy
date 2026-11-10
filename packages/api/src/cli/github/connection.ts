import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import type {AgentRow} from '@proxy/db/agent';
import {type ConnectionRow, listConnectionsWithCredential} from '@proxy/db/connection';
import {PAP_CONNECTION_HEADER} from '@proxy/contracts/cli-github';
import type {Integration} from '@proxy/integrations';

import {actionRefusal, actionsOf, agentViewer, requireAgent} from '../../agent-side/tools';
import {unavailableActions} from '../../connections/unavailable';
import {loadConnection} from '../../records/target';
import {integrationOf} from '../../utils/connection-actions';
import type {CliCaller} from '../authenticate';

/**
 * The GitHub connection a request from a sandbox is for, and what the agent can do with it: the one
 * it names in `PAP_CONNECTION_HEADER`, among those the agent reaches, a shared one as much as its
 * person's own; without one, the agent's only GitHub connection it can do anything with, or its only
 * one at all where it can do nothing with any. Several, and none named, is refused with their ids,
 * saying how to name one.
 */

export type GitHubTarget = {
	agent: AgentRow;
	connection: ConnectionRow & {credential: string | null};
	integration: Integration;
	/** What the agent can do with it now, as the gate decides it. */
	actions: string[];
	unavailable: string[];
};

const GITHUB = 'github';

const NAME_ONE = `Name one with pap --connection <id> git … or pap --connection <id> gh …, which send it as the ${PAP_CONNECTION_HEADER} header.`;

function targetOf(agent: AgentRow, connection: ConnectionRow & {credential: string | null}, integration: Integration): GitHubTarget {
	const unavailable = unavailableActions(connection);
	return {agent, connection, integration, actions: actionsOf(agent, connection, integration, unavailable), unavailable};
}

function namedTarget(caller: CliCaller, agent: AgentRow, connectionId: string): Promise<Result<GitHubTarget, ApiError>> {
	return Do(async ($) => {
		const {connection, integration} = $(await loadConnection(agentViewer(caller.agent), connectionId));
		if (integration.id !== GITHUB) {
			return $(Err(ApiErr.validationError(`${connectionId} is ${integration.name}, not GitHub: name a GitHub connection, or none to use your only one.`)));
		}
		return targetOf(agent, connection, integration);
	});
}

// The agent's GitHub connections it can do anything with; where it has none, every one it reaches,
// so a request on its only one is refused for the action it lacks, and logged, rather than not found.
function onlyTarget(caller: CliCaller, agent: AgentRow): Promise<Result<GitHubTarget, ApiError>> {
	return Do(async ($) => {
		const reached = $(await listConnectionsWithCredential(agentViewer(caller.agent))).flatMap((connection) => {
			const integration = connection.integrationId === GITHUB ? integrationOf(connection) : undefined;
			return integration ? [targetOf(agent, connection, integration)] : [];
		});
		const usable = reached.filter((target) => target.actions.length > 0);
		const candidates = usable.length > 0 ? usable : reached;
		const [only] = candidates;
		if (only === undefined) {
			return $(Err(ApiErr.notFound('connection', undefined, 'You have no GitHub connection: the person has to connect GitHub in Personal Agent Proxy, or allow you one.')));
		}
		if (candidates.length > 1) {
			const listed = candidates.map((target) => `${target.connection.id} (${target.connection.account})`).join(', ');
			return $(Err(ApiErr.validationError(`You have several GitHub connections: ${listed}. ${NAME_ONE}`)));
		}
		return only;
	});
}

/** The GitHub connection the request names, or the agent's only one. */
export function githubTarget(caller: CliCaller, named: string | undefined): Promise<Result<GitHubTarget, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireAgent(caller.agent));
		const connectionId = named?.trim() ?? '';
		return $(connectionId === '' ? await onlyTarget(caller, agent) : await namedTarget(caller, agent, connectionId));
	});
}

/**
 * Why the agent can't take `actionId` on the connection, in words for a model: what the sign-in
 * didn't cover, or the action it doesn't have, with what needed it.
 */
export function refusalMessage(target: GitHubTarget, actionId: string, neededFor: string): string {
	const {integration, agent, connection, unavailable, actions} = target;
	const refused = actionRefusal(integration, agent, connection, unavailable, actionId);
	if (refused.kind !== 'forbidden' && 'message' in refused && refused.message) {
		return refused.message;
	}
	// An action that only counts with another, as Push with Read, is refused for the other where that is what is off.
	const required = integration.actions.find((action) => action.id === actionId)?.requires;
	const missing = required !== undefined && !actions.includes(required) ? required : actionId;
	const label = integration.actions.find((action) => action.id === missing)?.label ?? missing;
	return `Not allowed: ${label} (${missing}), which ${neededFor} needs, on GitHub connection ${connection.id}. The person who made this login can allow it.`;
}
