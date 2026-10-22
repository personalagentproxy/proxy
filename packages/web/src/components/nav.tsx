import {
	BotIcon,
	HomeIcon,
	LibraryIcon,
	LogOutIcon,
	MessageSquareIcon,
	PlugIcon,
	ScrollTextIcon,
	SettingsIcon,
	type LucideIcon,
} from 'lucide-react';
import type {Experiment} from '@proxy/utils';
import {Link, useLocation, useRouteLoaderData} from 'react-router';
import {signOut} from '@/client/auth-client';
import type {Me} from '@/client/me-client';
import {ThemeMenu} from '@/components/theme-menu';
import {useExperiments} from '@/hooks/use-experiment';
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@proxy/ui/components/sidebar';

// `experiment` is the experiment a destination is behind, shown only with it on.
type Destination = {to: string; label: string; icon: LucideIcon; experiment?: Experiment};

const DESTINATIONS: Destination[] = [
	{to: '/', label: 'Home', icon: HomeIcon},
	{to: '/chat', label: 'Chat', icon: MessageSquareIcon, experiment: 'harness'},
	{to: '/connections', label: 'Connections', icon: PlugIcon},
	{to: '/vault', label: 'Vault', icon: LibraryIcon},
	{to: '/agents', label: 'Agents', icon: BotIcon},
	{to: '/activity', label: 'Activity', icon: ScrollTextIcon},
];

// Each destination is lit on its own pages too, as `/connections/:id`; Home only on itself, since
// every path starts with `/`.
function isActive(pathname: string, to: string): boolean {
	return to === '/' ? pathname === '/' : pathname.startsWith(to);
}

// The stock shadcn sidebar: a rail in icon mode on desktop, labels in tooltips and ⌘B to expand
// it; a sheet from the left on phones, opened from the header and closed again on every pick.
export function AppSidebar() {
	const {pathname} = useLocation();
	const me = useRouteLoaderData<Me>('human');
	const experiments = useExperiments();
	const {setOpenMobile} = useSidebar();
	const destinations = DESTINATIONS.filter(
		(destination) =>
			destination.experiment === undefined || experiments.includes(destination.experiment),
	);

	return (
		<Sidebar collapsible="icon">
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{destinations.map((destination) => (
							<SidebarMenuItem key={destination.to}>
								<SidebarMenuButton
									isActive={isActive(pathname, destination.to)}
									tooltip={destination.label}
									render={<Link to={destination.to} onClick={() => setOpenMobile(false)} />}
								>
									<destination.icon />
									<span>{destination.label}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							isActive={pathname.startsWith('/settings')}
							tooltip="Settings"
							render={<Link to="/settings" onClick={() => setOpenMobile(false)} />}
						>
							<SettingsIcon />
							<span>Settings</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<ThemeMenu />
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarMenuButton
							tooltip={me ? `Sign out ${me.user.email}` : 'Sign out'}
							onClick={() => void signOut()}
						>
							<LogOutIcon />
							<span>Sign out</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}
