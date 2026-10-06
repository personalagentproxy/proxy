import {Navigate, Outlet} from 'react-router';
import {useStore} from '@/components/mock-store';

// The agent side, behind the agent's own sign-in. A revoked login is signed out on its next page.
export function AgentSide() {
	const {agent} = useStore();
	if (!agent) {
		return <Navigate to="/agent/login" replace />;
	}

	return <Outlet />;
}
