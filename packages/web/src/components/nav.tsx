import {
	BellIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ChartNoAxesGanttIcon,
	ListChecksIcon,
	MessageSquareIcon,
	PlugIcon,
	SearchIcon,
	type LucideIcon,
} from 'lucide-react';
import {Link, useLocation} from 'react-router';
import {prefetchPersonaList} from '@/client/harness-client';
import {OrgSwitcher} from '@/components/org-switcher';
import {SidebarPanelHost} from '@/components/sidebar-panel';
import {useSidebarPanel} from '@/hooks/use-sidebar-panel';
import {PersonAvatar} from '@/components/person-avatar';
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
import {cn} from '@proxy/ui/lib/utils';
import {useCommandPalette} from '@/hooks/use-command-palette';
import {useHuman} from '@/hooks/use-human';
import {useOrgSlug} from '@/hooks/use-org';
import {useUnread} from '@/hooks/use-unread';
import {accountPath} from '@/lib/orgs';
import {shortcutLabel} from '@/lib/platform';

type Destination = {to: string; label: string; icon: LucideIcon};

const CHAT = '/chat';

// How many conversations have something unread, on Chat, at the row's end.
// Before the chevron, where the row has one.
function UnreadBadge({count, beforeChevron}: {count: number; beforeChevron: boolean}) {
	return (
		<span
			role="status"
			aria-label={`${count} unread`}
			className={cn(
				'pointer-events-none absolute top-1/2 flex h-4 min-w-4 -translate-y-1/2 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-medium text-primary-foreground',
				beforeChevron ? 'right-8' : 'right-2',
			)}
		>
			{count}
		</span>
	);
}

// The organization's, under the switcher, each under its slug, in groups set apart from each
// other, the first under Search. Its members and settings are in the switcher.
const GROUPS: Destination[][] = [
	[{to: CHAT, label: 'Chat', icon: MessageSquareIcon}],
	[
		{to: '/connections', label: 'Connections and permissions', icon: PlugIcon},
		{to: '/agents', label: 'External agents', icon: ListChecksIcon},
	],
	[
		{to: '/activity', label: 'Activity', icon: ChartNoAxesGanttIcon},
		{to: '/alerts', label: 'Alerts', icon: BellIcon},
	],
];

// The stock shadcn sidebar: on desktop a column the person folds away entirely and back out from
// the title bar (title-bar.tsx); a sheet from the left on phones, opened from there too and closed
// again on every pick. The organization switcher sits at its top, with the command bar's button
// (Cmd+K) and the organization's pages in groups under it; the person's account, where they sign
// out, at its foot. On a page with a panel of its own, as Chat's agents, the sidebar drills into
// it instead (sidebar-panel.tsx), under a way back up to all this.
export function AppSidebar() {
	const {pathname} = useLocation();
	const human = useHuman();
	const unread = useUnread();
	const {setOpenMobile} = useSidebar();
	const palette = useCommandPalette();
	const org = useOrgSlug();
	const panel = useSidebarPanel();
	const drilled = panel.label !== null && !panel.up;
	const base = `/${org}`;
	// Whether the destination is the open page, with a panel of its own to drill into.
	const opensPanel = (to: string) => panel.label !== null && pathname.startsWith(`${base}${to}`);
	return (
		<Sidebar>
			{/* The navigation and the page's panel side by side, the sidebar shifting over to the one
			    shown; the other out of reach. */}
			<div className="relative min-h-0 flex-1 overflow-hidden">
				<div
					className={cn(
						'flex h-full w-[200%] transition-transform duration-200 ease-out motion-reduce:transition-none',
						drilled && '-translate-x-1/2',
					)}
				>
					<div inert={drilled} aria-hidden={drilled} className="flex h-full w-1/2 flex-col">
						{/* Its row's highlight starting at the title bar's line. */}
						<SidebarHeader className="pt-0">
							<SidebarMenu>
								<SidebarMenuItem>
									<OrgSwitcher />
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarHeader>
						<SidebarContent>
							{GROUPS.map((group, index) => (
								<SidebarGroup key={index} className={index === 0 ? 'pt-0' : undefined}>
									<SidebarMenu>
										{index === 0 && (
											<SidebarMenuItem>
												<SidebarMenuButton
													className="rounded-full"
													onClick={() => {
														setOpenMobile(false);
														palette.toggle();
													}}
												>
													<SearchIcon />
													<span>Search</span>
													{/* The command bar's shortcut. */}
													<span aria-hidden className="ml-auto text-xs text-muted-foreground">
														{shortcutLabel('k')}
													</span>
												</SidebarMenuButton>
											</SidebarMenuItem>
										)}
										{group.map((destination) => (
											<SidebarMenuItem key={destination.to}>
												<SidebarMenuButton
													// Lit on its own pages too, as `/acme/connections/:id`.
													isActive={pathname.startsWith(`${base}${destination.to}`)}
													className="rounded-full"
													render={
														<Link
															to={`${base}${destination.to}`}
															// Chat's agents asked for as the pointer or the keyboard heads for it, so they are
															// there as its page opens.
															onPointerEnter={
																destination.to === CHAT ? () => prefetchPersonaList(org) : undefined
															}
															onFocus={
																destination.to === CHAT ? () => prefetchPersonaList(org) : undefined
															}
															onClick={(event) => {
																// Its page open, back into its panel rather than to its first address.
																if (opensPanel(destination.to)) {
																	event.preventDefault();
																	panel.setUp(false);
																	return;
																}
																setOpenMobile(false);
															}}
														/>
													}
												>
													<destination.icon />
													<span>{destination.label}</span>
													{/* The open page's panel, gone back up from: a way back into it. */}
													{opensPanel(destination.to) && (
														<ChevronRightIcon className="ml-auto text-muted-foreground" />
													)}
												</SidebarMenuButton>
												{destination.to === CHAT && unread.unreadIds.size > 0 && (
													<UnreadBadge
														count={unread.unreadIds.size}
														beforeChevron={opensPanel(destination.to)}
													/>
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
										className="rounded-full"
										render={<Link to={accountPath(org)} onClick={() => setOpenMobile(false)} />}
									>
										<span className="flex size-4 shrink-0 items-center justify-center">
											{human ? <PersonAvatar person={human.user} className="size-6" /> : null}
										</span>
										<span>Account</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarFooter>
					</div>
					<div inert={!drilled} aria-hidden={!drilled} className="flex h-full w-1/2 flex-col">
						{/* Its row's highlight starting at the title bar's line. */}
						<SidebarHeader className="py-0">
							<SidebarMenu>
								<SidebarMenuItem>
									<SidebarMenuButton
										aria-label={`${panel.label}, back to the menu`}
										className="rounded-full font-medium"
										onClick={() => panel.setUp(true)}
									>
										<ChevronLeftIcon />
										<span>{panel.label}</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarHeader>
						<SidebarPanelHost />
					</div>
				</div>
			</div>
		</Sidebar>
	);
}
