import {Navigate, createBrowserRouter, redirect} from 'react-router';
import {agentCollectionLoader, agentRecordLoader, agentSideLoader} from '@/agent-loaders';
import {getSignInMethods, type SignInMethods} from '@/client/auth-client';
import {getMe} from '@/client/me-client';
import {AgentSide} from '@/components/agent-side';
import {HumanSide} from '@/components/human-side';
import {RouteError} from '@/components/route-error';
import {sanitizeCallbackUrl} from '@/lib/callback-url';
import {unwrapLoaderResult} from '@/lib/loader-utils';
import {
	activityLoader,
	agentLoader,
	agentsLoader,
	connectAgentLoader,
	connectionLoader,
	connectionsLoader,
	infoLoader,
} from '@/loaders';
import {ActivityPage} from '@/pages/activity-page';
import {AddConnectionPage} from '@/pages/add-connection-page';
import {AgentPage} from '@/pages/agent-page';
import {AgentsPage} from '@/pages/agents-page';
import {AgentCollectionPage} from '@/pages/agent/agent-collection-page';
import {AgentHomePage} from '@/pages/agent/agent-home-page';
import {AgentLoginPage} from '@/pages/agent/agent-login-page';
import {AgentNewRecordPage} from '@/pages/agent/agent-new-record-page';
import {AgentRecordPage} from '@/pages/agent/agent-record-page';
import {ConnectAgentPage} from '@/pages/connect-agent-page';
import {ConnectionPage} from '@/pages/connection-page';
import {ConnectionsPage} from '@/pages/connections-page';
import {InfoPage} from '@/pages/info-page';
import {LoginPage} from '@/pages/login-page';

// The human side's guard: no session sends the user to /login, and back here after.
async function humanLoader() {
	return unwrapLoaderResult(await getMe());
}

// A signed-in user has no business on the login page; anything else, an api outage included,
// shows the form, with Google unless the api says it is not set up.
async function loginLoader({request}: {request: Request}): Promise<SignInMethods> {
	const [me, methods] = await Promise.all([getMe(), getSignInMethods()]);
	if (me.isErr()) {
		return methods.unwrapOr({google: true});
	}

	const callbackUrl = sanitizeCallbackUrl(new URL(request.url).searchParams.get('callbackUrl'));
	throw redirect(callbackUrl ?? '/');
}

export const router = createBrowserRouter([
	{path: '/login', loader: loginLoader, element: <LoginPage />},
	{path: '/agent/login', element: <AgentLoginPage />},
	// An MCP client, such as Claude, signing in as one of the person's agents.
	{
		path: '/connect-agent',
		loader: connectAgentLoader,
		element: <ConnectAgentPage />,
		errorElement: <RouteError />,
	},
	{
		id: 'human',
		loader: humanLoader,
		// Once per page load: the session is checked on arrival, not on every click.
		shouldRevalidate: () => false,
		element: <HumanSide />,
		errorElement: <RouteError />,
		children: [
			{path: '/', element: <Navigate to="/connections" replace />},
			{path: '/connections', loader: connectionsLoader, element: <ConnectionsPage />},
			{path: '/connections/new', element: <AddConnectionPage />},
			{path: '/connections/:id', loader: connectionLoader, element: <ConnectionPage />},
			{path: '/info', loader: infoLoader, element: <InfoPage />},
			{path: '/agents', loader: agentsLoader, element: <AgentsPage />},
			{path: '/agents/:id', loader: agentLoader, element: <AgentPage />},
			{path: '/activity', loader: activityLoader, element: <ActivityPage />},
		],
	},
	{
		id: 'agent',
		loader: agentSideLoader,
		element: <AgentSide />,
		errorElement: <RouteError />,
		children: [
			{path: '/agent', element: <AgentHomePage />},
			{
				path: '/agent/:connectionId/:collectionId',
				loader: agentCollectionLoader,
				element: <AgentCollectionPage />,
			},
			{path: '/agent/:connectionId/:collectionId/new', element: <AgentNewRecordPage />},
			{
				path: '/agent/:connectionId/:collectionId/:recordId',
				loader: agentRecordLoader,
				element: <AgentRecordPage />,
			},
		],
	},
	{path: '*', element: <Navigate to="/" replace />},
]);
