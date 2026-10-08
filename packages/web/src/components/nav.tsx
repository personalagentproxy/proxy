import {
	BotIcon,
	IdCardIcon,
	LogOutIcon,
	PlugIcon,
	ScrollTextIcon,
	type LucideIcon,
} from 'lucide-react';
import {Link, useLocation, useRouteLoaderData} from 'react-router';
import {signOut} from '@/client/auth-client';
import type {Me} from '@/client/me-client';
import {ThemeMenu} from '@/components/theme-menu';
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

type Destination = {to: string; label: string; icon: LucideIcon};

const DESTINATIONS: Destination[] = [
	{to: '/connections', label: 'Connections', icon: PlugIcon},
	{to: '/info', label: 'Information', icon: IdCardIcon},
	{to: '/agents', label: 'Agents', icon: BotIcon},
	{to: '/activity', label: 'Activity', icon: ScrollTextIcon},
];

// The stock shadcn sidebar: a rail in icon mode on desktop, labels in tooltips and ⌘B to expand
// it; a sheet from the left on phones, opened from the header and closed again on every pick.
export function AppSidebar() {
	const {pathname} = useLocation();
	const me = useRouteLoaderData<Me>('human');
	const {setOpenMobile} = useSidebar();

	return (
		<Sidebar collapsible="icon">
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{DESTINATIONS.map((destination) => (
							<SidebarMenuItem key={destination.to}>
								<SidebarMenuButton
									isActive={pathname.startsWith(destination.to)}
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
