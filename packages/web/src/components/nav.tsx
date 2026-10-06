import {
	BotIcon,
	IdCardIcon,
	LogOutIcon,
	PlugIcon,
	ScrollTextIcon,
	SquareTerminalIcon,
	type LucideIcon,
} from 'lucide-react';
import {Link, useLocation, useNavigate} from 'react-router';
import {useStore} from '@/components/mock-store';
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from '@/components/ui/sidebar';

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
	const navigate = useNavigate();
	const {signOutHuman} = useStore();
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
					{/* The mock runs both sides in one tab, so the agent's door is a link away. */}
					<SidebarMenuItem>
						<SidebarMenuButton tooltip="Agent sign-in" render={<Link to="/agent/login" />}>
							<SquareTerminalIcon />
							<span>Agent sign-in</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
					<SidebarMenuItem>
						<SidebarMenuButton
							tooltip="Sign out"
							onClick={() => {
								signOutHuman();
								navigate('/login');
							}}
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
