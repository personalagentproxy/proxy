import type {ActivityFilter} from '@proxy/contracts/activity';
import {createDesktopCode, getSignInMethods} from '@/client/auth-client';
import {
	getActivityTimeline,
	getAgent,
	getTaskRun,
	listActivity,
	listAgents,
	listMcpClients,
} from '@/client/agents-client';
import {getConnection, listConnections} from '@/client/connections-client';
import {getFile, listFiles, listTrashedFiles} from '@/client/files-client';
import {getGitHubInstallations} from '@/client/github-client';
import {listAlerts} from '@/client/alerts-client';
import {getThread, listPersonas} from '@/client/harness-client';
import {getClaudeAccount, getMe, listSessions} from '@/client/me-client';
import {getAuthorizationRequest} from '@/client/oauth-client';
import {getInvitation, getOrg, listMembers, listOrgs} from '@/client/orgs-client';
import {listRecords} from '@/client/records-client';
import {
	FILES_INTEGRATION_ID,
	SANDBOX_INTEGRATION_ID,
	VAULT_INTEGRATION_ID,
} from '@proxy/integrations';
import {desktopChallengeSchema} from '@proxy/contracts/auth';
import {desktopAuthLink} from '@/lib/desktop';
import {drivePlace} from '@/lib/files';
import {LOADED_MINUTES, windowStart} from '@/lib/timeline-window';
import {describeApiError, later, unwrapLoaderResult, unwrapOrNull} from '@/lib/loader-utils';
import {pendingAgent} from '@/lib/pending-agent';
import {redirect, type ShouldRevalidateFunctionArgs} from 'react-router';

// The human side's pages, each loaded from the api on arrival and again after every change. Every
// page is in an organization, named by its slug in the address (`params.org`), which its api
// calls are about. A page in the app's frame answers `later`: it opens at once, the frame first,
// and its content when the api has answered. The pages outside it, as the welcome flow, open once
// it has.

type OrgParams = {params: {org?: string}};

function orgOf({params}: OrgParams): string {
	return params.org ?? '';
}

// Home: what is connected, for the logos under its input, and what the agents are doing, for the
// timeline under them. The page works without them, so a list the api doesn't answer shows as
// empty, and a timeline it doesn't as none, rather than as an error.
export const homeLoader = later(async (args: OrgParams) => {
	const org = orgOf(args);
	const [connections, agents, activity] = await Promise.all([
		listConnections(org),
		listAgents(org),
		getActivityTimeline(org, windowStart(LOADED_MINUTES, new Date()).toISOString()),
	]);
	return {
		connections: connections.map((answer) => answer.connections).unwrapOr([]),
		agents: agents.map((answer) => answer.agents).unwrapOr([]),
		activity: activity.unwrapOr(null),
	};
});

// The timeline writes its window to the address as it moves (agent-timeline.tsx) and reads what
// that needs itself, so a change of the window alone doesn't load its page, home or activity, again.
export function shouldRevalidateTimeline({
	currentUrl,
	nextUrl,
	defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
	if (currentUrl.pathname !== nextUrl.pathname || currentUrl.search === nextUrl.search) {
		return defaultShouldRevalidate;
	}
	const withoutWindow = (url: URL) => {
		const params = new URLSearchParams(url.search);
		params.delete('window');
		params.delete('end');
		return params.toString();
	};
	if (withoutWindow(currentUrl) !== withoutWindow(nextUrl)) {
		return defaultShouldRevalidate;
	}
	return false;
}

export const connectionsLoader = later(async (args: OrgParams) => {
	const org = orgOf(args);
	const [connections, agents] = await Promise.all([listConnections(org), listAgents(org)]);
	return {
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
	};
});

// The catalog, with how many accounts of each integration are connected, and whether the server
// has what each needs (`/auth/methods`); an api that doesn't answer leaves every integration on
// offer, and a sign-in that can't start says what is missing.
export const addConnectionLoader = later(async (args: OrgParams) => {
	const [connections, methods] = await Promise.all([
		listConnections(orgOf(args)),
		getSignInMethods(),
	]);
	return {
		connections: unwrapLoaderResult(connections).connections,
		configured: methods.map(({needs}) => needs).unwrapOr({google: true, plaid: true, github: true}),
	};
});

export const connectionLoader = later(
	async (args: {params: {org?: string; id?: string}; request: Request}) => {
		const org = orgOf(args);
		const id = args.params.id ?? '';
		const [connection, connections, agents, activity, members] = await Promise.all([
			getConnection(org, id),
			listConnections(org),
			listAgents(org),
			listActivity(org, {connectionId: id}),
			listMembers(org),
		]);
		const {entries, tasks} = unwrapLoaderResult(activity);
		const found = unwrapOrNull(connection);
		// What a connection kept in Personal Agent Proxy holds is the first tab of its page: a vault's
		// entries, the Sandboxes' sandboxes; null for every other connection.
		const kept = async (integrationId: string, collectionId: string) => {
			if (found?.integrationId !== integrationId) {
				return null;
			}
			return unwrapLoaderResult(await listRecords(org, found.id, collectionId)).records;
		};
		// What a GitHub connection reaches is its first tab too; GitHub out of reach is said on the tab
		// rather than failing the page.
		const reached = async () => {
			if (found?.integrationId !== 'github') {
				return null;
			}
			const answer = await getGitHubInstallations(org, found.id);
			return answer.isOk() ? answer.value : {error: describeApiError(answer.error)};
		};
		// A drive's page is where the person is in it, as its query says (lib/files.ts): the folder
		// opened or the trash, and a file shown over it. Null for a folder or a file that isn't there,
		// which the tab says rather than failing the page.
		const drive = async () => {
			if (found?.integrationId !== FILES_INTEGRATION_ID) {
				return null;
			}
			const place = drivePlace(new URL(args.request.url).searchParams);
			const [list, shown] = await Promise.all([
				place.trash
					? listTrashedFiles(org, found.id)
					: listFiles(org, found.id, place.folder, place.search),
				place.file === null ? null : getFile(org, found.id, place.file),
			]);
			return {place, list: unwrapOrNull(list), shown: shown === null ? null : unwrapOrNull(shown)};
		};
		const [vaultEntries, sandboxes, github, files] = await Promise.all([
			kept(VAULT_INTEGRATION_ID, 'entries'),
			kept(SANDBOX_INTEGRATION_ID, 'sandboxes'),
			reached(),
			drive(),
		]);
		return {
			connection: found,
			connections: unwrapLoaderResult(connections).connections,
			agents: unwrapLoaderResult(agents).agents,
			entries,
			tasks,
			// Whom it can be shared with by name.
			members: unwrapLoaderResult(members).members,
			vaultEntries,
			sandboxes,
			github,
			files,
		};
	},
);

// Chat opens on the persona the person was last active with, the first the api lists, which makes
// one where the organization has none yet.
export const chatIndexLoader = later(async (args: OrgParams) => {
	const org = orgOf(args);
	const {personas} = unwrapLoaderResult(await listPersonas(org));
	const first = personas[0];
	if (!first) {
		throw redirect(`/${org}`);
	}
	throw redirect(`/${org}/chat/${first.id}`);
});

// The person's conversation with an agent, the agents to switch between, and the harnesses one
// can run on.
export const chatLoader = later(async (args: OrgParams & {params: {id?: string}}) => {
	const org = orgOf(args);
	const [log, personas] = await Promise.all([
		getThread(org, args.params.id ?? ''),
		listPersonas(org),
	]);
	const {personas: listed, harnesses} = unwrapLoaderResult(personas);
	return {log: unwrapLoaderResult(log), personas: listed, harnesses};
});

// The person's alerts, those the agents set in their conversations.
export const alertsLoader = later(async (args: OrgParams) => {
	return unwrapLoaderResult(await listAlerts(orgOf(args)));
});

// The addresses of the vault and of Sandboxes from when each had a page of its own, where a saved
// link still opens it: each is the first tab of its connection's page now, the person's own
// vault's or Sandboxes' where the address names none.
function builtInRedirect(integrationId: string) {
	return async (args: {params: {org?: string; id?: string}}) => {
		const org = orgOf(args);
		const {id} = args.params;
		if (id !== undefined) {
			throw redirect(`/${org}/connections/${id}`);
		}
		const {connections} = unwrapLoaderResult(await listConnections(org));
		const own = connections.find(
			(candidate) => candidate.integrationId === integrationId && candidate.builtIn,
		);
		throw redirect(own ? `/${org}/connections/${own.id}` : `/${org}/connections`);
	};
}

export const vaultLoader = builtInRedirect(VAULT_INTEGRATION_ID);
export const sandboxesLoader = builtInRedirect(SANDBOX_INTEGRATION_ID);

export const agentsLoader = later(async (args: OrgParams) => {
	return {agents: unwrapLoaderResult(await listAgents(orgOf(args))).agents};
});

export const agentLoader = later(async (args: {params: {org?: string; id?: string}}) => {
	const org = orgOf(args);
	const id = args.params.id ?? '';
	const [agent, connections, agents, activity, mcpClients, members] = await Promise.all([
		getAgent(org, id),
		listConnections(org),
		listAgents(org),
		listActivity(org, {agentId: id}),
		listMcpClients(org, id),
		listMembers(org),
	]);
	const {entries, tasks} = unwrapLoaderResult(activity);
	const found = unwrapOrNull(agent);
	return {
		agent: found,
		// Every one for whoever may change the agent; anyone else, the ones they signed in
		// themselves. None for an agent not found, which its page says so of.
		mcpClients: found === null ? [] : unwrapLoaderResult(mcpClients).clients,
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
		entries,
		tasks,
		// Who has it, on its Sharing tab.
		members: unwrapLoaderResult(members).members,
	};
});

export const agentSetupLoader = later(async (args: {params: {org?: string; id?: string}}) => {
	return {agent: unwrapOrNull(await getAgent(orgOf(args), args.params.id ?? ''))};
});

export function activityLoader(args: OrgParams & {request: Request}) {
	const org = orgOf(args);
	const search = new URL(args.request.url).searchParams;
	// The log narrowed to one task, as it once was: that task's page.
	const task = search.get('task');
	if (task) {
		throw redirect(`/${org}/activity/tasks/${encodeURIComponent(task)}`);
	}
	const outcome = search.get('outcome');
	return loadActivity({
		org,
		filter: {
			agentId: search.get('agent') ?? undefined,
			connectionId: search.get('connection') ?? undefined,
			outcome:
				outcome === 'allowed' || outcome === 'denied' || outcome === 'failed' ? outcome : undefined,
		},
	});
}

const loadActivity = later(async ({org, filter}: {org: string; filter: ActivityFilter}) => {
	const [activity, connections, agents, timeline] = await Promise.all([
		listActivity(org, filter),
		listConnections(org),
		listAgents(org),
		getActivityTimeline(org, windowStart(LOADED_MINUTES, new Date()).toISOString()),
	]);
	const {entries, tasks} = unwrapLoaderResult(activity);
	return {
		entries,
		tasks,
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
		// The home page's timeline over the log; the log works without it, as home does.
		timeline: timeline.unwrapOr(null),
	};
});

// A task's page: the task, its sub-tasks and every request made for them, with the connections
// and agents to name what each request used and who made it. Null where the task is
// not one the person sees, so the page says so in its own frame.
export const taskLoader = later(async (args: {params: {org?: string; taskId?: string}}) => {
	const org = orgOf(args);
	const [run, connections, agents] = await Promise.all([
		getTaskRun(org, args.params.taskId ?? ''),
		listConnections(org),
		listAgents(org),
	]);
	return {
		run: unwrapOrNull(run),
		connections: unwrapLoaderResult(connections).connections,
		agents: unwrapLoaderResult(agents).agents,
	};
});

// Connecting an MCP client: who is asking, the person's organizations, and the agents of the one
// it starts in, which they can let it work as: the agent being set up in this browser's, else the
// first; the page loads another organization's as it is picked. Without a session, signing in
// comes first and returns here.
export async function connectAgentLoader({request}: {request: Request}) {
	const sealed = new URL(request.url).searchParams.get('request') ?? '';
	const [orgs, details] = await Promise.all([listOrgs(), getAuthorizationRequest(sealed)]);
	const memberOf = unwrapLoaderResult(orgs).orgs;
	if (details.isErr()) {
		return {
			kind: 'error',
			message:
				'The request from the app has expired, or it is not one Personal Agent Proxy made. Start connecting again from the app you came from.',
		} as const;
	}
	const pending = pendingAgent();
	const org = memberOf.find((candidate) => candidate.slug === pending?.org) ?? memberOf[0];
	if (!org) {
		return {
			kind: 'error',
			message:
				'You are in no organization, so there is no agent to work as. Ask someone to invite you to theirs.',
		} as const;
	}
	return {
		kind: 'ok',
		request: sealed,
		details: details.value,
		orgs: memberOf,
		org: org.slug,
		agents: unwrapLoaderResult(await listAgents(org.slug)).agents,
		pendingAgentId: pending?.agentId ?? null,
	} as const;
}

export type ConnectAgentData = Awaited<ReturnType<typeof connectAgentLoader>>;

// The person's account: their sessions, every browser and desktop app they are signed in on, and
// how their own Claude account is connected, if it is.
export const accountLoader = later(async () => {
	const [sessions, claude] = await Promise.all([listSessions(), getClaudeAccount()]);
	return {...unwrapLoaderResult(sessions), claude: unwrapLoaderResult(claude).account};
});

// The organization's members and invitations.
export const membersLoader = later(async (args: OrgParams) => {
	return unwrapLoaderResult(await listMembers(orgOf(args)));
});

// An invitation's link, signed in (anyone signed out signs in or up first and comes back): who is
// signed in, and what the link is for, null for none.
export async function inviteLoader({params}: {params: {token?: string}}) {
	const [me, invitation] = await Promise.all([getMe(), getInvitation(params.token ?? '')]);
	return {me: unwrapLoaderResult(me), invitation: unwrapOrNull(invitation)};
}

// The desktop app's sign-in, `/desktop-auth?challenge=`: the one-time code for the signed-in
// person, bound to the app's challenge, in the link that hands it over. Signed out, the person
// signs in first and comes back here; a challenge that isn't one opens the app's root instead.
export async function desktopAuthLoader({request}: {request: Request}) {
	const url = new URL(request.url);
	const challenge = desktopChallengeSchema.safeParse(url.searchParams.get('challenge'));
	if (!challenge.success) {
		throw redirect('/');
	}
	const signIn = `/login?callbackUrl=${encodeURIComponent(url.pathname + url.search)}`;
	const {code} = unwrapLoaderResult(await createDesktopCode(challenge.data), signIn);
	return {link: desktopAuthLink(code)};
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
		configured: methods.map(({needs}) => needs).unwrapOr({google: true, plaid: true, github: true}),
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
