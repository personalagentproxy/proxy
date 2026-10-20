import {findCollection, type Collection} from '@proxy/integrations';
import {useParams, useRouteLoaderData} from 'react-router';
import type {AgentMe, AgentTask} from '@/client/agent-client';
import {integrationOf, type Integration} from '@/lib/integrations';

export type AgentTarget = {
	connection: AgentMe['connections'][number];
	integration: Integration;
	collection: Collection;
	// The actions the agent can take with the connection.
	actions: string[];
	// What the breadcrumbs call the connection: the mailbox's address, or Information.
	place: string;
};

// The signed-in agent and what it can reach, from the agent side's loader.
export function useAgentMe(): AgentMe | null {
	return useRouteLoaderData<AgentMe>('agent') ?? null;
}

// The task an agent page is on, from the loader of the task's pages; null on the task list and the
// feedback form, which aren't any task's.
export function useAgentTask(): AgentTask | null {
	return useRouteLoaderData<AgentTask>('agent-task') ?? null;
}

// The connection and collection an agent page's URL points at, among those the agent can reach;
// null for anything else, which the api then refuses or doesn't find.
export function useAgentTarget(): AgentTarget | null {
	const {connectionId = '', collectionId = ''} = useParams();
	const me = useAgentMe();
	const connection = me?.connections.find((candidate) => candidate.id === connectionId);
	const integration = connection && integrationOf(connection);
	const collection = integration && findCollection(integration, collectionId);
	if (!connection || !integration || !collection) {
		return null;
	}

	const place = integration.builtIn ? integration.name : connection.account;
	return {connection, integration, collection, actions: connection.actions, place};
}
