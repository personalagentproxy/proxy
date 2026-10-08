import {getAgent, listActivity, listAgents, listMcpClients} from '@/client/agents-client';
import {getConnection, listConnections} from '@/client/connections-client';
import {getAuthorizationRequest} from '@/client/oauth-client';
import {listRecords} from '@/client/records-client';
import {INFO_INTEGRATION_ID} from '@proxy/integrations';
import {findIntegration} from '@/lib/integrations';
import {unwrapLoaderResult, unwrapOrNull} from '@/lib/loader-utils';

// The human side's pages, each loaded from the api on arrival and again after every change.

export async function connectionsLoader() {
	const [connections, agents] = await Promise.all([listConnections(), listAgents()]);
	return {
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
	};
}

export async function connectionLoader({params}: {params: {id?: string}}) {
	const id = params.id ?? '';
	const [connection, connections, agents, activity] = await Promise.all([
		getConnection(id),
		listConnections(),
		listAgents(),
		listActivity({connectionId: id}),
	]);
	return {
		connection: unwrapOrNull(connection),
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
		entries: unwrapLoaderResult(activity).entries,
	};
}

// Information is the one built-in connection; its records are kept in Personal Agent Proxy.
export async function infoLoader() {
	const {connections} = unwrapLoaderResult(await listConnections());
	const connection = connections.find(
		(candidate) => candidate.integrationId === INFO_INTEGRATION_ID,
	);
	if (!connection) {
		throw new Error('The organization has no Information connection');
	}

	const collections = findIntegration(INFO_INTEGRATION_ID)?.collections ?? [];
	const records = await Promise.all(
		collections.map(
			async (collection) =>
				[
					collection.id,
					unwrapLoaderResult(await listRecords(connection.id, collection.id)).records,
				] as const,
		),
	);
	return {connectionId: connection.id, records: Object.fromEntries(records)};
}

export async function agentsLoader() {
	return {agents: unwrapLoaderResult(await listAgents()).agents};
}

export async function agentLoader({params}: {params: {id?: string}}) {
	const id = params.id ?? '';
	const [agent, connections, agents, activity, mcpClients] = await Promise.all([
		getAgent(id),
		listConnections(),
		listAgents(),
		listActivity({agentId: id}),
		listMcpClients(id),
	]);
	return {
		agent: unwrapOrNull(agent),
		mcpClients: unwrapLoaderResult(mcpClients).clients,
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
		entries: unwrapLoaderResult(activity).entries,
	};
}

export async function activityLoader({request}: {request: Request}) {
	const params = new URL(request.url).searchParams;
	const filter = {
		agentId: params.get('agent') ?? undefined,
		connectionId: params.get('connection') ?? undefined,
	};
	const [activity, connections, agents] = await Promise.all([
		listActivity(filter),
		listConnections(),
		listAgents(),
	]);
	return {
		entries: unwrapLoaderResult(activity).entries,
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
	};
}

// Connecting an MCP client: who is asking, and the agents the person can let it work as. Without
// a session, signing in comes first and returns here.
export async function connectAgentLoader({request}: {request: Request}) {
	const sealed = new URL(request.url).searchParams.get('request') ?? '';
	const [agents, details] = await Promise.all([listAgents(), getAuthorizationRequest(sealed)]);
	const signedIn = unwrapLoaderResult(agents).agents;
	if (details.isErr()) {
		return {
			kind: 'error',
			message:
				'The request from the app has expired, or it is not one Personal Agent Proxy made. Start connecting again from the app you came from.',
		} as const;
	}
	return {kind: 'ok', request: sealed, details: details.value, agents: signedIn} as const;
}

export type ConnectAgentData = Awaited<ReturnType<typeof connectAgentLoader>>;
