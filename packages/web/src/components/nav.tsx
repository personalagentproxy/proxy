import {
	BotIcon,
	CircleUserIcon,
	HomeIcon,
	LibraryIcon,
	LogOutIcon,
	PlugIcon,
	ScrollTextIcon,
	SettingsIcon,
	UsersIcon,
	type LucideIcon,
} from 'lucide-react';
import {Link, useLocation} from 'react-router';
import {signOut} from '@/client/auth-client';
import {OrgSwitcher} from '@/components/org-switcher';
import {ThemeMenu} from '@/components/theme-menu';
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@proxy/ui/components/sidebar';
import {useHuman} from '@/hooks/use-human';

type Destination = {to: string; label: string; icon: LucideIcon};

// The organization's, under the switcher, each under its slug.
const DESTINATIONS: Destination[] = [
	{to: '', label: 'Home', icon: HomeIcon},
	{to: '/connections', label: 'Connections', icon: PlugIcon},
	{to: '/agents', label: 'Agents', icon: BotIcon},
	{to: '/vault', label: 'Vault', icon: LibraryIcon},
	{to: '/activity', label: 'Activity', icon: ScrollTextIcon},
	{to: '/members', label: 'Members', icon: UsersIcon},
	{to: '/settings', label: 'Settings', icon: SettingsIcon},
];

// Each destination is lit on its own pages too, as `/acme/connections/:id`; Home only on itself,
// since every path in the organization starts with its slug.
function isActive(pathname: string, path: string, home: string): boolean {
	return path === home ? pathname === home : pathname.startsWith(path);
}

// The stock shadcn sidebar: a rail in icon mode on desktop, labels in tooltips and ⌘B to expand
// it; a sheet from the left on phones, opened from the header and closed again on every pick. The
// organization switcher sits at its top, with the organization's pages under it; the person's own,
// their account, theme and signing out, at its foot.
export function AppSidebar() {
	const {pathname} = useLocation();
	const human = useHuman();
	const {setOpenMobile} = useSidebar();
	const home = `/${human?.org.slug ?? ''}`;

	return (
		<Sidebar collapsible="icon">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<OrgSwitcher />
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup className="pt-0">
					<SidebarMenu>
						{DESTINATIONS.map((destination) => (
							<SidebarMenuItem key={destination.to}>
								<SidebarMenuButton
									isActive={isActive(pathname, `${home}${destination.to}`, home)}
									tooltip={destination.label}
									render={
										<Link to={`${home}${destination.to}`} onClick={() => setOpenMobile(false)} />
									}
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
							isActive={pathname === '/account'}
							tooltip="Account"
							render={<Link to="/account" onClick={() => setOpenMobile(false)} />}
						>
							<CircleUserIcon />
							<span>Account</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<ThemeMenu />
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarMenuButton
							tooltip={human ? `Sign out ${human.user.email}` : 'Sign out'}
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
