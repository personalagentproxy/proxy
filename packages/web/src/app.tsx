import {Navigate, Outlet, Route, Routes} from 'react-router';
import {useStore} from '@/components/mock-store';
import {SidebarProvider} from '@/components/ui/sidebar';
import {TooltipProvider} from '@/components/ui/tooltip';
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

// The sidebar remembers whether it was expanded in the cookie its provider writes.
function sidebarExpanded(): boolean {
	return document.cookie.split('; ').includes('sidebar_state=true');
}

// The human side, behind its sign-in. The sidebar starts as a rail; ⌘B expands it.
function HumanSide() {
	const {session} = useStore();
	if (!session.human) {
		return <Navigate to="/login" replace />;
	}

	return (
		<SidebarProvider defaultOpen={sidebarExpanded()}>
			<Outlet />
		</SidebarProvider>
	);
}

// The agent side, behind the agent's own sign-in. A revoked login is signed out on its next page.
function AgentSide() {
	const {agent} = useStore();
	if (!agent) {
		return <Navigate to="/agent/login" replace />;
	}

	return <Outlet />;
}

export function App() {
	return (
		<TooltipProvider>
			<Routes>
				<Route path="/login" element={<LoginPage />} />
				<Route path="/agent/login" element={<AgentLoginPage />} />
				<Route element={<HumanSide />}>
					<Route path="/" element={<Navigate to="/connections" replace />} />
					<Route path="/connections" element={<ConnectionsPage />} />
					<Route path="/connections/new" element={<AddConnectionPage />} />
					<Route path="/connections/:id" element={<ConnectionPage />} />
					<Route path="/info" element={<InfoPage />} />
					<Route path="/agents" element={<AgentsPage />} />
					<Route path="/agents/:id" element={<AgentPage />} />
					<Route path="/activity" element={<ActivityPage />} />
				</Route>
				<Route element={<AgentSide />}>
					<Route path="/agent" element={<AgentHomePage />} />
					<Route path="/agent/:connectionId/:collectionId" element={<AgentCollectionPage />} />
					<Route path="/agent/:connectionId/:collectionId/new" element={<AgentNewRecordPage />} />
					<Route
						path="/agent/:connectionId/:collectionId/:recordId"
						element={<AgentRecordPage />}
					/>
				</Route>
				<Route path="*" element={<Navigate to="/" replace />} />
			</Routes>
		</TooltipProvider>
	);
}
