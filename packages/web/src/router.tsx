import {Outlet, createBrowserRouter, redirect} from 'react-router';
import {
	agentCollectionLoader,
	agentRecordLoader,
	agentSideLoader,
	agentTaskLoader,
	agentTasksLoader,
	shouldRevalidateAgentTask,
} from '@/agent-loaders';
import {getSignInMethods, type SignInMethods} from '@/client/auth-client';
import {getMe, isNotFoundError} from '@/client/me-client';
import {getOrg, listOrgs} from '@/client/orgs-client';
import {HumanSide} from '@/components/human-side';
import {RouteError} from '@/components/route-error';
import {sanitizeCallbackUrl} from '@/lib/callback-url';
import {unwrapLoaderResult} from '@/lib/loader-utils';
import type {Human} from '@/lib/orgs';
import {
	activityLoader,
	addConnectionLoader,
	agentLoader,
	agentSetupLoader,
	agentsLoader,
	connectAgentLoader,
	connectionLoader,
	connectionsLoader,
	homeLoader,
	inviteLoader,
	membersLoader,
	vaultLoader,
	welcomeConnectionLoader,
	welcomeLoader,
} from '@/loaders';
import {ActivityPage} from '@/pages/activity-page';
import {AddBankPage} from '@/pages/add-bank-page';
import {AddConnectionPage} from '@/pages/add-connection-page';
import {AddDatabasePage} from '@/pages/add-database-page';
import {AddEmailPage} from '@/pages/add-email-page';
import {AddMcpPage} from '@/pages/add-mcp-page';
import {AgentPage} from '@/pages/agent-page';
import {AgentSetupPage} from '@/pages/agent-setup-page';
import {AgentsPage} from '@/pages/agents-page';
import {AgentCollectionPage} from '@/pages/agent/agent-collection-page';
import {AgentFeedbackPage} from '@/pages/agent/agent-feedback-page';
import {AgentHomePage} from '@/pages/agent/agent-home-page';
import {AgentLoginPage} from '@/pages/agent/agent-login-page';
import {AgentNewRecordPage} from '@/pages/agent/agent-new-record-page';
import {AgentRecordPage} from '@/pages/agent/agent-record-page';
import {AgentTaskPage} from '@/pages/agent/agent-task-page';
import {AgentToolPage} from '@/pages/agent/agent-tool-page';
import {ConnectAgentPage} from '@/pages/connect-agent-page';
import {ConnectionPage} from '@/pages/connection-page';
import {ConnectionsPage} from '@/pages/connections-page';
import {HomePage} from '@/pages/home-page';
import {InvitePage} from '@/pages/invite-page';
import {LoginPage} from '@/pages/login-page';
import {MembersPage} from '@/pages/members-page';
import {NewAgentPage} from '@/pages/new-agent-page';
import {SettingsPage} from '@/pages/settings-page';
import {VaultPage} from '@/pages/vault-page';
import {WelcomeConnectionPage, WelcomePage} from '@/pages/welcome-page';

// The app's root: no organization in the address, so the person's first opens, the one made at
// sign-up until they join or make another. Without a session, /login. A person in no organization
// at all, which deleting one guards against, is told so rather than sent to /login and back.
async function rootLoader() {
	const {orgs} = unwrapLoaderResult(await listOrgs());
	const first = orgs[0];
	if (!first) {
		throw new Error('You are in no organization. Ask someone to invite you to theirs.');
	}
	throw redirect(`/${first.slug}`);
}

// The app's pages before every page was one organization's: a saved link to one, or to a page
// under it (`/connections/<id>`, `/agents/new`), opens it in the person's first organization.
const LEGACY_PAGES = new Map([
	['connections', 'connections'],
	['agents', 'agents'],
	['activity', 'activity'],
	['vault', 'vault'],
	['info', 'vault'],
	['settings', 'settings'],
]);

// The first part of an address's path: `connections` in `/connections/<id>`.
function firstSegment(url: URL): string {
	return url.pathname.split('/')[1] ?? '';
}

// Where an old link opens in the person's first organization; the root for any other address.
function legacyRedirect(url: URL, first: string | undefined): string {
	const slug = firstSegment(url);
	const page = LEGACY_PAGES.get(slug);
	if (page === undefined || first === undefined) {
		return '/';
	}
	const rest = url.pathname.slice(`/${slug}`.length);
	return `/${first}/${page}${rest}${url.search}`;
}

// Any address no route has: an old link to a page under one of the pages above, which no
// organization's route matches, opens it in the person's first organization; anything else, the
// root.
async function unknownLoader({request}: {request: Request}) {
	const url = new URL(request.url);
	if (!LEGACY_PAGES.has(firstSegment(url))) {
		throw redirect('/');
	}
	const first = unwrapLoaderResult(await listOrgs()).orgs[0]?.slug;
	throw redirect(legacyRedirect(url, first));
}

// The human side's guard, on every page in an organization (`/:org/…`): no session sends the user
// to /login, and back here after; an organization that isn't theirs sends them to their first, an
// old single-page link (`/connections`) to that page there; one that has not been
// through the welcome flow goes there first. With who is signed in, the
// organization and the organizations they are in, for the switcher and every page that says which
// is open.
async function humanLoader({
	params,
	request,
}: {
	params: {org?: string};
	request: Request;
}): Promise<Human> {
	const slug = params.org ?? '';
	const [me, org, orgs] = await Promise.all([getMe(), getOrg(slug), listOrgs()]);
	const signedIn = unwrapLoaderResult(me);
	if (org.isErr() && isNotFoundError(org.error)) {
		const first = unwrapLoaderResult(orgs).orgs[0]?.slug;
		throw redirect(legacyRedirect(new URL(request.url), first));
	}
	const named = unwrapLoaderResult(org);
	if (!named.onboarded) {
		throw redirect(`/${slug}/welcome/connections`);
	}
	return {...signedIn, org: named, orgs: unwrapLoaderResult(orgs).orgs};
}

// A signed-in user has no business on the login page; anything else, an api outage included,
// shows the form, with Google unless the api says it is not set up.
async function loginLoader({request}: {request: Request}): Promise<SignInMethods> {
	const [me, methods] = await Promise.all([getMe(), getSignInMethods()]);
	if (me.isErr()) {
		return methods.unwrapOr({google: true, needs: {google: true, plaid: true}});
	}

	const callbackUrl = sanitizeCallbackUrl(new URL(request.url).searchParams.get('callbackUrl'));
	throw redirect(callbackUrl ?? '/');
}

export const router = createBrowserRouter([
	{path: '/', loader: rootLoader, element: null, errorElement: <RouteError />},
	{path: '/login', loader: loginLoader, element: <LoginPage />},
	{path: '/agent/login', element: <AgentLoginPage />},
	// An MCP client, such as Claude, signing in as one of the person's agents.
	{
		path: '/connect-agent',
		loader: connectAgentLoader,
		element: <ConnectAgentPage />,
		errorElement: <RouteError />,
	},
	// An invitation's link, outside any organization like the welcome flow.
	{
		path: '/invite/:token',
		loader: inviteLoader,
		element: <InvitePage />,
		errorElement: <RouteError />,
	},
	// The welcome flow of a new organization: the person's connections, then their agent, before
	// the app itself. A connection made in it gets a page of its own, for its permissions.
	{
		path: '/:org/welcome/connections',
		loader: welcomeLoader,
		element: <WelcomePage step="connections" />,
		errorElement: <RouteError />,
	},
	{
		path: '/:org/welcome/connections/email',
		loader: welcomeLoader,
		element: <WelcomePage step="email" />,
		errorElement: <RouteError />,
	},
	{
		path: '/:org/welcome/connections/postgres',
		loader: welcomeLoader,
		element: <WelcomePage step="postgres" />,
		errorElement: <RouteError />,
	},
	{
		path: '/:org/welcome/connections/mysql',
		loader: welcomeLoader,
		element: <WelcomePage step="mysql" />,
		errorElement: <RouteError />,
	},
	{
		path: '/:org/welcome/connections/plaid',
		loader: welcomeLoader,
		element: <WelcomePage step="plaid" />,
		errorElement: <RouteError />,
	},
	{
		path: '/:org/welcome/connections/mcp',
		loader: welcomeLoader,
		element: <WelcomePage step="mcp" />,
		errorElement: <RouteError />,
	},
	{
		path: '/:org/welcome/connections/:id',
		loader: welcomeConnectionLoader,
		element: <WelcomeConnectionPage />,
		errorElement: <RouteError />,
	},
	{
		path: '/:org/welcome/agent',
		loader: welcomeLoader,
		element: <WelcomePage step="agent" />,
		errorElement: <RouteError />,
	},
	// Everything in an organization, under its slug: the address says which, so a link, a bookmark
	// or another tab stands on its own.
	{
		id: 'human',
		path: '/:org',
		loader: humanLoader,
		// The session is checked on arrival, not on every click: only another organization, or a
		// page revalidating after a change (the address the same), as renaming an organization or
		// inviting someone, loads the organizations again.
		shouldRevalidate: ({currentUrl, nextUrl, currentParams, nextParams}) =>
			currentParams.org !== nextParams.org || currentUrl.href === nextUrl.href,
		element: <HumanSide />,
		errorElement: <RouteError />,
		children: [
			{index: true, loader: homeLoader, element: <HomePage />},
			{path: '/:org/connections', loader: connectionsLoader, element: <ConnectionsPage />},
			{path: '/:org/connections/new', loader: addConnectionLoader, element: <AddConnectionPage />},
			{path: '/:org/connections/new/email', element: <AddEmailPage />},
			{path: '/:org/connections/new/postgres', element: <AddDatabasePage dialect="postgres" />},
			{path: '/:org/connections/new/mysql', element: <AddDatabasePage dialect="mysql" />},
			{path: '/:org/connections/new/plaid', element: <AddBankPage />},
			{path: '/:org/connections/new/mcp', element: <AddMcpPage />},
			{path: '/:org/connections/:id', loader: connectionLoader, element: <ConnectionPage />},
			{path: '/:org/vault', loader: vaultLoader, element: <VaultPage />},
			{path: '/:org/agents', loader: agentsLoader, element: <AgentsPage />},
			{path: '/:org/agents/new', loader: agentsLoader, element: <NewAgentPage />},
			{path: '/:org/agents/:id', loader: agentLoader, element: <AgentPage />},
			{path: '/:org/agents/:id/setup', loader: agentSetupLoader, element: <AgentSetupPage />},
			{path: '/:org/activity', loader: activityLoader, element: <ActivityPage />},
			{path: '/:org/members', loader: membersLoader, element: <MembersPage />},
			{path: '/:org/settings', element: <SettingsPage />},
		],
	},
	{
		id: 'agent',
		loader: agentSideLoader,
		element: <Outlet />,
		errorElement: <RouteError />,
		children: [
			// The agent's tasks, to open one or start another: where it starts, and where it is sent
			// without one.
			{path: '/agent', loader: agentTasksLoader, element: <AgentTaskPage />},
			{path: '/agent/feedback', element: <AgentFeedbackPage />},
			// A task's pages, each making its requests for the task in its address.
			{
				id: 'agent-task',
				path: '/agent/:taskId',
				loader: agentTaskLoader,
				shouldRevalidate: shouldRevalidateAgentTask,
				element: <Outlet />,
				children: [
					{index: true, element: <AgentHomePage />},
					// A custom MCP server's tool, which has no collection.
					{path: '/agent/:taskId/:connectionId/tool/:toolName', element: <AgentToolPage />},
					{
						path: '/agent/:taskId/:connectionId/:collectionId',
						loader: agentCollectionLoader,
						element: <AgentCollectionPage />,
					},
					{
						path: '/agent/:taskId/:connectionId/:collectionId/new',
						element: <AgentNewRecordPage />,
					},
					{
						path: '/agent/:taskId/:connectionId/:collectionId/:recordId',
						loader: agentRecordLoader,
						element: <AgentRecordPage />,
					},
				],
			},
		],
	},
	{path: '*', loader: unknownLoader, element: null, errorElement: <RouteError />},
]);
