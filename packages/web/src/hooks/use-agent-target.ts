import {findCollection, type Access, type Collection} from '@proxy/integrations';
import {useParams, useRouteLoaderData} from 'react-router';
import type {AgentMe} from '@/client/agent-client';
import {findIntegration, type Integration} from '@/lib/integrations';

export type AgentTarget = {
	connection: AgentMe['connections'][number];
	integration: Integration;
	collection: Collection;
	access: Access;
};

// The signed-in agent and what it can reach, from the agent side's loader.
export function useAgentMe(): AgentMe | null {
	return useRouteLoaderData<AgentMe>('agent') ?? null;
}

// The connection and collection an agent page's URL points at, among those the agent can reach;
// null for anything else, which the api then refuses or doesn't find.
export function useAgentTarget(): AgentTarget | null {
	const {connectionId = '', collectionId = ''} = useParams();
	const me = useAgentMe();
	const connection = me?.connections.find((candidate) => candidate.id === connectionId);
	const integration = connection && findIntegration(connection.integrationId);
	const collection = integration && findCollection(integration, collectionId);
	const access = connection?.collections.find((candidate) => candidate.id === collectionId)?.access;
	if (!connection || !integration || !collection || !access) {
		return null;
	}

	return {connection, integration, collection, access};
}
