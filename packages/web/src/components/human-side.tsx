import {Outlet} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {UnreadProvider} from '@/components/unread-provider';
import {useOrgSlug} from '@/hooks/use-org';

// The human side, behind its sign-in (the route's loader). The sidebar is always a rail on
// desktop. Keyed by the organization, so a page switched to another's starts over, rather than
// keeping what was typed, picked or open in the one before; what is unread in the organization's
// conversations is kept around every page of it.
export function HumanSide() {
	const org = useOrgSlug();
	return (
		<SidebarProvider collapsed>
			<UnreadProvider key={org}>
				<Outlet />
			</UnreadProvider>
		</SidebarProvider>
	);
}
