import {Outlet} from 'react-router';
import {SidebarProvider} from '@proxy/ui/components/sidebar';
import {CommandPaletteProvider} from '@/components/command-palette';
import {AppSidebar} from '@/components/nav';
import {SidebarPanelProvider} from '@/components/sidebar-panel';
import {TitleBarStart} from '@/components/title-bar';
import {UnreadProvider} from '@/components/unread-provider';
import {useOrgSlug} from '@/hooks/use-org';
import {useSidebarFolded} from '@/hooks/use-sidebar-folded';

// The human side, behind its sign-in (the route's loader). The navigation is the same one on every
// page, out on desktop until the person folds it away from the title bar's start, and kept so.
// Keyed by the organization, so a page switched to another's starts over, rather than keeping what
// was typed, picked or open in the one before; what is unread in the conversations of the
// sidebar's organization, the one the account page was opened from there, is kept around every
// page, and so is the command bar that Cmd+K opens over any of them.
export function HumanSide() {
	const org = useOrgSlug();
	const {folded, setFolded} = useSidebarFolded();
	return (
		<SidebarProvider collapsed={folded} onCollapsedChange={setFolded}>
			<UnreadProvider key={org}>
				<CommandPaletteProvider>
					<SidebarPanelProvider>
						<AppSidebar />
						<Outlet key={org} />
						{/* After the page: the desktop app takes the window's drag surface from the page
						    in order, the later over the earlier, and with the navigation folded away the
						    page's header, which drags the window, reaches under the toggle. */}
						<TitleBarStart />
					</SidebarPanelProvider>
				</CommandPaletteProvider>
			</UnreadProvider>
		</SidebarProvider>
	);
}
