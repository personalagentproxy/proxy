import {Outlet} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {UnreadProvider} from '@/components/unread-provider';
import {useHuman} from '@/hooks/use-human';
import {useOrgSlug} from '@/hooks/use-org';

// The human side, behind its sign-in (the route's loader). The sidebar is always a rail on
// desktop. Keyed by the organization, so a page switched to another's starts over, rather than
// keeping what was typed, picked or open in the one before; what is unread in the conversations
// of the sidebar's organization, the person's first on their account page, is kept around every
// page.
export function HumanSide() {
	const org = useOrgSlug();
	const human = useHuman();
	return (
		<SidebarProvider collapsed>
			<UnreadProvider key={human?.org.slug}>
				<Outlet key={org} />
			</UnreadProvider>
		</SidebarProvider>
	);
}
