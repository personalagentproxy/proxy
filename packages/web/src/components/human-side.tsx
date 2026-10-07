import {Outlet} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';

// The sidebar remembers whether it was expanded in the cookie its provider writes.
function sidebarExpanded(): boolean {
	return document.cookie.split('; ').includes('sidebar_state=true');
}

// The human side, behind its sign-in (the route's loader). The sidebar starts as a rail; ⌘B
// expands it.
export function HumanSide() {
	return (
		<SidebarProvider defaultOpen={sidebarExpanded()}>
			<Outlet />
		</SidebarProvider>
	);
}
