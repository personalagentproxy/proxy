import {getSignInMethods} from '@/client/auth-client';
import {
	type ActivityFilter,
	getActivityLanes,
	getAgent,
	listActivity,
	listAgents,
	listMcpClients,
} from '@/client/agents-client';
import {getConnection, listConnections} from '@/client/connections-client';
import {getMe} from '@/client/me-client';
import {getAuthorizationRequest} from '@/client/oauth-client';
import {getInvitation, getOrg, listMembers, listOrgs} from '@/client/orgs-client';
import {listRecords} from '@/client/records-client';
import {VAULT_INTEGRATION_ID} from '@proxy/integrations';
import {LOADED_MINUTES, windowStart} from '@/lib/agent-lanes';
import {unwrapLoaderResult, unwrapOrNull} from '@/lib/loader-utils';
import {pendingAgent} from '@/lib/pending-agent';
import {redirect} from 'react-router';

// The human side's pages, each loaded from the api on arrival and again after every change. Every
// page is in an organization, named by its slug in the address (`params.org`), which its api
// calls are about.

type OrgParams = {params: {org?: string}};

function orgOf({params}: OrgParams): string {
	return params.org ?? '';
}

// Home: what is connected, for the logos under its input, and what the agents are doing, for the
// lanes under them. The page works without them, so a list the api doesn't answer shows as empty,
// and lanes it doesn't as none, rather than as an error.
export async function homeLoader(args: OrgParams) {
	const org = orgOf(args);
	const [connections, agents, activity] = await Promise.all([
		listConnections(org),
		listAgents(org),
		getActivityLanes(org, windowStart(LOADED_MINUTES, new Date()).toISOString()),
	]);
	return {
		connections: connections.map((answer) => answer.connections).unwrapOr([]),
		agents: agents.map((answer) => answer.agents).unwrapOr([]),
		activity: activity.unwrapOr(null),
	};
}

export async function connectionsLoader(args: OrgParams) {
	const org = orgOf(args);
	const [connections, agents] = await Promise.all([listConnections(org), listAgents(org)]);
	return {
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
	};
}

// The catalog, with how many accounts of each integration are connected, and whether the server
// has what each needs (`/auth/methods`); an api that doesn't answer leaves every integration on
// offer, and a sign-in that can't start says what is missing.
export async function addConnectionLoader(args: OrgParams) {
	const [connections, methods] = await Promise.all([
		listConnections(orgOf(args)),
		getSignInMethods(),
	]);
	return {
		connections: unwrapLoaderResult(connections).connections,
		configured: methods.map(({needs}) => needs).unwrapOr({google: true, plaid: true}),
	};
}

export async function connectionLoader({params}: {params: {org?: string; id?: string}}) {
	const org = params.org ?? '';
	const id = params.id ?? '';
	const [connection, connections, agents, activity] = await Promise.all([
		getConnection(org, id),
		listConnections(org),
		listAgents(org),
		listActivity(org, {connectionId: id}),
	]);
	const {entries, tasks} = unwrapLoaderResult(activity);
	return {
		connection: unwrapOrNull(connection),
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
		entries,
		tasks,
	};
}

// The vault is the one built-in connection, the person's own in the organization; its entries
// are kept in Personal Agent Proxy.
export async function vaultLoader(args: OrgParams) {
	const org = orgOf(args);
	const {connections} = unwrapLoaderResult(await listConnections(org));
	const connection = connections.find(
		(candidate) => candidate.integrationId === VAULT_INTEGRATION_ID,
	);
	if (!connection) {
		throw new Error('The organization has no vault');
	}

	const {records} = unwrapLoaderResult(await listRecords(org, connection.id, 'entries'));
	return {connectionId: connection.id, entries: records};
}

export async function agentsLoader(args: OrgParams) {
	return {agents: unwrapLoaderResult(await listAgents(orgOf(args))).agents};
}

export async function agentLoader({params}: {params: {org?: string; id?: string}}) {
	const org = params.org ?? '';
	const id = params.id ?? '';
	const [agent, connections, agents, activity, mcpClients] = await Promise.all([
		getAgent(org, id),
		listConnections(org),
		listAgents(org),
		listActivity(org, {agentId: id}),
		listMcpClients(org, id),
	]);
	const {entries, tasks} = unwrapLoaderResult(activity);
	return {
		agent: unwrapOrNull(agent),
		// Only whoever may change the agent sees its MCP clients: none for anyone else.
		mcpClients: mcpClients.map((answer) => answer.clients).unwrapOr([]),
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
		entries,
		tasks,
	};
}

export async function agentSetupLoader({params}: {params: {org?: string; id?: string}}) {
	return {agent: unwrapOrNull(await getAgent(params.org ?? '', params.id ?? ''))};
}

export async function activityLoader({params, request}: OrgParams & {request: Request}) {
	const org = params.org ?? '';
	const search = new URL(request.url).searchParams;
	const outcome = search.get('outcome');
	const filter: ActivityFilter = {
		agentId: search.get('agent') ?? undefined,
		connectionId: search.get('connection') ?? undefined,
		taskId: search.get('task') ?? undefined,
		outcome: outcome === 'allowed' || outcome === 'denied' ? outcome : undefined,
	};
	const [activity, connections, agents] = await Promise.all([
		listActivity(org, filter),
		listConnections(org),
		listAgents(org),
	]);
	const {entries, tasks} = unwrapLoaderResult(activity);
	return {
		entries,
		tasks,
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
	};
}

// Connecting an MCP client: who is asking, the person's organizations, and the agents of the one
// it starts in, which they can let it work as: the agent being set up in this browser's, else the
// first; the page loads another organization's as it is picked. Without a session, signing in
// comes first and returns here.
export async function connectAgentLoader({request}: {request: Request}) {
	const sealed = new URL(request.url).searchParams.get('request') ?? '';
	const [orgs, details] = await Promise.all([listOrgs(), getAuthorizationRequest(sealed)]);
	const memberOf = unwrapLoaderResult(orgs).orgs;
	const pending = pendingAgent();
	const org = memberOf.find((candidate) => candidate.slug === pending?.org) ?? memberOf[0];
	const agents = org ? unwrapLoaderResult(await listAgents(org.slug)).agents : [];
	if (details.isErr()) {
		return {
			kind: 'error',
			message:
				'The request from the app has expired, or it is not one Personal Agent Proxy made. Start connecting again from the app you came from.',
		} as const;
	}
	return {
		kind: 'ok',
		request: sealed,
		details: details.value,
		orgs: memberOf,
		org: org?.slug ?? '',
		agents,
		pendingAgentId: pending?.agentId ?? null,
	} as const;
}

export type ConnectAgentData = Awaited<ReturnType<typeof connectAgentLoader>>;

// The organization's members and invitations.
export async function membersLoader(args: OrgParams) {
	return unwrapLoaderResult(await listMembers(orgOf(args)));
}

// An invitation's link, signed in (anyone signed out signs in or up first and comes back): who is
// signed in, and what the link is for, null for none.
export async function inviteLoader({params}: {params: {token?: string}}) {
	const [me, invitation] = await Promise.all([getMe(), getInvitation(params.token ?? '')]);
	return {me: unwrapLoaderResult(me), invitation: unwrapOrNull(invitation)};
}

// The welcome flow, shown until the organization finishes or skips it: what the person has
// connected so far, so each step can say what is done, and what the server has set up for the
// catalog. Once finished, the app itself.
export async function welcomeLoader(args: OrgParams) {
	const org = orgOf(args);
	const [named, agents, connections, methods] = await Promise.all([
		getOrg(org),
		listAgents(org),
		listConnections(org),
		getSignInMethods(),
	]);
	const {onboarded, experiments} = unwrapLoaderResult(named);
	if (onboarded) {
		throw redirect(`/${org}/connections`);
	}
	return {
		experiments,
		agents: unwrapLoaderResult(agents).agents,
		connections: unwrapLoaderResult(connections).connections,
		configured: methods.map(({needs}) => needs).unwrapOr({google: true, plaid: true}),
	};
}

// The welcome flow's page for one connection just made: its permissions, to confirm.
export async function welcomeConnectionLoader(args: {params: {org?: string; id?: string}}) {
	const [data, connection] = await Promise.all([
		welcomeLoader(args),
		getConnection(orgOf(args), args.params.id ?? ''),
	]);
	return {...data, connection: unwrapOrNull(connection)};
}
