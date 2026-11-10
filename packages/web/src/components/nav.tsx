import {
	BellIcon,
	ChartNoAxesGanttIcon,
	HomeIcon,
	ListChecksIcon,
	MessageSquareIcon,
	PlugIcon,
	SearchIcon,
	type LucideIcon,
} from 'lucide-react';
import type {Experiment} from '@proxy/utils';
import {Link, useLocation} from 'react-router';
import {OrgSwitcher} from '@/components/org-switcher';
import {PersonAvatar} from '@/components/person-avatar';
import {useExperiments} from '@/hooks/use-experiment';
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
import {useCommandPalette} from '@/hooks/use-command-palette';
import {useHuman} from '@/hooks/use-human';
import {useUnread} from '@/hooks/use-unread';
import {shortcutLabel} from '@/lib/platform';

// `experiment` is the experiment a destination is behind, shown only with it on.
type Destination = {to: string; label: string; icon: LucideIcon; experiment?: Experiment};

const CHAT = '/chat';

// How many conversations have something unread, on Chat: over the icon's corner on the rail, at
// the row's end where the labels show.
function UnreadBadge({count}: {count: number}) {
	return (
		<span
			role="status"
			aria-label={`${count} unread`}
			className="pointer-events-none absolute top-1/2 right-2 flex h-4 min-w-4 -translate-y-1/2 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-medium text-primary-foreground group-data-[collapsible=icon]:top-0 group-data-[collapsible=icon]:right-0 group-data-[collapsible=icon]:translate-y-0"
		>
			{count}
		</span>
	);
}

// The organization's, under the switcher, each under its slug, in groups set apart from each
// other. Its members and settings are in the switcher.
const GROUPS: Destination[][] = [
	[
		{to: '', label: 'Home', icon: HomeIcon},
		{to: '/chat', label: 'Chat', icon: MessageSquareIcon, experiment: 'harness'},
	],
	[
		{to: '/connections', label: 'Connections and permissions', icon: PlugIcon},
		{to: '/agents', label: 'External agents', icon: ListChecksIcon},
	],
	[
		{to: '/activity', label: 'Activity', icon: ChartNoAxesGanttIcon},
		{to: '/alerts', label: 'Alerts', icon: BellIcon, experiment: 'harness'},
	],
];

// Each destination is lit on its own pages too, as `/acme/connections/:id`; Home only on itself,
// since every path in the organization starts with its slug.
function isActive(pathname: string, path: string, home: string): boolean {
	return path === home ? pathname === home : pathname.startsWith(path);
}

// The stock shadcn sidebar: always a rail in icon mode on desktop, labels in tooltips; a sheet from
// the left on phones, opened from the header and closed again on every pick. The organization
// switcher sits at its top, with the command bar's button (Cmd+K) and the organization's pages in
// groups under it; the person's account, where they sign out, at its foot.
export function AppSidebar() {
	const {pathname} = useLocation();
	const human = useHuman();
	const experiments = useExperiments();
	const unread = useUnread();
	const {setOpenMobile} = useSidebar();
	const palette = useCommandPalette();
	const home = `/${human?.org.slug ?? ''}`;
	const groups = GROUPS.map((group) =>
		group.filter(
			(destination) =>
				destination.experiment === undefined || experiments.includes(destination.experiment),
		),
	);

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
				{groups.map((group, index) => (
					<SidebarGroup key={index} className={index === 0 ? 'pt-0' : undefined}>
						<SidebarMenu>
							{index === 0 && (
								<SidebarMenuItem>
									<SidebarMenuButton
										tooltip={`Search ${shortcutLabel('k')}`}
										onClick={() => {
											setOpenMobile(false);
											palette.toggle();
										}}
									>
										<SearchIcon />
										<span>Search</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							)}
							{group.map((destination) => (
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
									{destination.to === CHAT && unread.unreadIds.size > 0 && (
										<UnreadBadge count={unread.unreadIds.size} />
									)}
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroup>
				))}
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							isActive={pathname === '/account'}
							tooltip="Account"
							render={<Link to="/account" onClick={() => setOpenMobile(false)} />}
						>
							<span className="flex size-4 shrink-0 items-center justify-center">
								{human ? <PersonAvatar person={human.user} className="size-6" /> : null}
							</span>
							<span>Account</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}
