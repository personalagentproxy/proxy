import {Navigate, createBrowserRouter, redirect} from 'react-router';
import {getMe} from '@/client/me-client';
import {AgentSide} from '@/components/agent-side';
import {HumanSide} from '@/components/human-side';
import {RouteError} from '@/components/route-error';
import {sanitizeCallbackUrl} from '@/lib/callback-url';
import {unwrapLoaderResult} from '@/lib/loader-utils';
import {ActivityPage} from '@/pages/activity-page';
import {AddConnectionPage} from '@/pages/add-connection-page';
import {AgentPage} from '@/pages/agent-page';
import {AgentsPage} from '@/pages/agents-page';
import {AgentCollectionPage} from '@/pages/agent/agent-collection-page';
import {AgentHomePage} from '@/pages/agent/agent-home-page';
import {AgentLoginPage} from '@/pages/agent/agent-login-page';
import {AgentNewRecordPage} from '@/pages/agent/agent-new-record-page';
import {AgentRecordPage} from '@/pages/agent/agent-record-page';
import {ConnectionPage} from '@/pages/connection-page';
import {ConnectionsPage} from '@/pages/connections-page';
import {InfoPage} from '@/pages/info-page';
import {LoginPage} from '@/pages/login-page';

// The human side's guard: no session sends the user to /login, and back here after.
async function humanLoader() {
	return unwrapLoaderResult(await getMe());
}

// A signed-in user has no business on the login page; anything else, an api outage included,
// shows the form.
async function loginLoader({request}: {request: Request}) {
	const result = await getMe();
	if (result.isErr()) {
		return null;
	}

	const callbackUrl = sanitizeCallbackUrl(new URL(request.url).searchParams.get('callbackUrl'));
	throw redirect(callbackUrl ?? '/');
}

export const router = createBrowserRouter([
	{path: '/login', loader: loginLoader, element: <LoginPage />},
	{path: '/agent/login', element: <AgentLoginPage />},
	{
		id: 'human',
		loader: humanLoader,
		// Once per page load: the session is checked on arrival, not on every click.
		shouldRevalidate: () => false,
		element: <HumanSide />,
		errorElement: <RouteError />,
		children: [
			{path: '/', element: <Navigate to="/connections" replace />},
			{path: '/connections', element: <ConnectionsPage />},
			{path: '/connections/new', element: <AddConnectionPage />},
			{path: '/connections/:id', element: <ConnectionPage />},
			{path: '/info', element: <InfoPage />},
			{path: '/agents', element: <AgentsPage />},
			{path: '/agents/:id', element: <AgentPage />},
			{path: '/activity', element: <ActivityPage />},
		],
	},
	{
		element: <AgentSide />,
		children: [
			{path: '/agent', element: <AgentHomePage />},
			{path: '/agent/:connectionId/:collectionId', element: <AgentCollectionPage />},
			{path: '/agent/:connectionId/:collectionId/new', element: <AgentNewRecordPage />},
			{path: '/agent/:connectionId/:collectionId/:recordId', element: <AgentRecordPage />},
		],
	},
	{path: '*', element: <Navigate to="/" replace />},
]);
