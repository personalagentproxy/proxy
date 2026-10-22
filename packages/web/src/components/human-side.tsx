import {Outlet} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {useOrgSlug} from '@/hooks/use-org';

// The sidebar remembers whether it was expanded in the cookie its provider writes.
function sidebarExpanded(): boolean {
	return document.cookie.split('; ').includes('sidebar_state=true');
}

// The human side, behind its sign-in (the route's loader). The sidebar starts as a rail; ⌘B
// expands it. Keyed by the organization, so a page switched to another's starts over, rather than
// keeping what was typed, picked or open in the one before.
export function HumanSide() {
	const org = useOrgSlug();
	return (
		<SidebarProvider defaultOpen={sidebarExpanded()}>
			<Outlet key={org} />
		</SidebarProvider>
	);
}
