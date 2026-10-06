import {Outlet} from 'react-router';

// The agent side, behind the agent's own sign-in (the route's loader). A revoked login is signed
// out on its next page.
export function AgentSide() {
	return <Outlet />;
}
