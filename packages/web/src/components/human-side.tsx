import {Outlet} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {useOrgSlug} from '@/hooks/use-org';

// The human side, behind its sign-in (the route's loader). The sidebar is always a rail on
// desktop. Keyed by the organization, so a page switched to another's starts over, rather than
// keeping what was typed, picked or open in the one before.
export function HumanSide() {
	const org = useOrgSlug();
	return (
		<SidebarProvider collapsed>
			<Outlet key={org} />
		</SidebarProvider>
	);
}
