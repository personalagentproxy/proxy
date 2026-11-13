import {CheckIcon, ChevronsUpDownIcon, PlusIcon, SettingsIcon, UsersIcon} from 'lucide-react';
import {useState} from 'react';
import {Link, useLocation, useNavigate} from 'react-router';
import {createOrg} from '@/client/orgs-client';
import {PillButton} from '@proxy/ui/components/pill-button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLinkItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@proxy/ui/components/dropdown-menu';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {SidebarMenuButton, useSidebar} from '@proxy/ui/components/sidebar';
import {cn} from '@proxy/ui/lib/utils';
import {useHuman} from '@/hooks/use-human';
import {describeApiError} from '@/lib/loader-utils';

// An organization's mark: its initial in a circle the size of an integration's logo.
export function OrgTile({org, className}: {org: {name: string}; className?: string}) {
	return (
		<span
			aria-hidden
			data-preserve-color
			className={cn(
				'flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground',
				className,
			)}
		>
			{org.name.slice(0, 1).toUpperCase()}
		</span>
	);
}

// A row of the switcher: a pill, with room at its ends for the round.
const MENU_ROW = 'rounded-full px-2.5';
// The switcher's corners: a row's round, half its 28px height, and the menu's 4px padding around
// it. No shadow.
const MENU_CORNERS = 'rounded-[18px] shadow-none';
// The lines between the switcher's parts: as faint as the lines between a table's rows.
const MENU_LINE = 'bg-border/60';

// The organization's own pages, in the switcher under its organizations.
const ORG_PAGES = [
	{to: '/members', label: 'Members', icon: UsersIcon},
	{to: '/settings', label: 'Settings', icon: SettingsIcon},
];

// The top of the sidebar: the organization the address names, with its mark. Hovering it, or
// clicking it on a touch screen, opens the switcher below it, with the organization's
// members and settings, lit while one of them is open. Everything on the human side is that
// organization's; switching goes to another's address, where it opens.
export function OrgSwitcher() {
	const human = useHuman();
	const {setOpenMobile} = useSidebar();
	const navigate = useNavigate();
	const {pathname} = useLocation();
	const [creating, setCreating] = useState(false);
	if (!human) {
		return null;
	}

	const activeOrg = human.org;
	const onOrgPage = ORG_PAGES.some((page) => pathname.startsWith(`/${activeOrg.slug}${page.to}`));
	const open = async (slug: string) => {
		setOpenMobile(false);
		await navigate(`/${slug}`);
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					openOnHover
					delay={100}
					closeDelay={200}
					render={
						// The tile is taller than the icons: the button's padding gives it the room.
						<SidebarMenuButton
							aria-label={`Organization: ${activeOrg.name}`}
							isActive={onOrgPage}
							className="rounded-full py-1.5"
						/>
					}
				>
					<OrgTile org={activeOrg} />
					<span className="min-w-0 flex-1 truncate">{activeOrg.name}</span>
					<ChevronsUpDownIcon className="ml-auto text-muted-foreground" />
				</DropdownMenuTrigger>
				{/* Below the switcher, as wide as it, flat on the sidebar, its rows lit as pills as the
				    sidebar's are. Its corners are as round as a row's ends and the gap around them,
				    so a lit first or last row keeps an even gap to the edge. */}
				<DropdownMenuContent side="bottom" align="start" sideOffset={4} className={MENU_CORNERS}>
					<DropdownMenuGroup>
						{human.orgs.map((org) => (
							<DropdownMenuItem
								key={org.id}
								className={MENU_ROW}
								onClick={() => void open(org.slug)}
							>
								{/* As small as the icons below it, so the names line up with their labels. */}
								<OrgTile org={org} className="size-4 text-[10px]" />
								<span className="min-w-0 flex-1 truncate">{org.name}</span>
								{org.id === activeOrg.id ? (
									<CheckIcon />
								) : (
									<span className="text-muted-foreground tabular-nums">
										{org.memberCount > 1 ? `${org.memberCount} members` : 'Just you'}
									</span>
								)}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator className={MENU_LINE} />
					<DropdownMenuGroup>
						{ORG_PAGES.map((page) => (
							<DropdownMenuLinkItem
								key={page.to}
								className={MENU_ROW}
								closeOnClick
								render={
									<Link to={`/${activeOrg.slug}${page.to}`} onClick={() => setOpenMobile(false)} />
								}
							>
								<page.icon />
								{page.label}
							</DropdownMenuLinkItem>
						))}
					</DropdownMenuGroup>
					<DropdownMenuSeparator className={MENU_LINE} />
					<DropdownMenuItem className={MENU_ROW} onClick={() => setCreating(true)}>
						<PlusIcon />
						Create organization
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<CreateOrgDialog
				key={String(creating)}
				open={creating}
				onClose={() => setCreating(false)}
				onCreate={async (name) => {
					const result = await createOrg(name);
					if (result.isErr()) {
						return describeApiError(result.error);
					}
					await open(result.value.slug);
					return null;
				}}
			/>
		</>
	);
}

function CreateOrgDialog({
	open,
	onClose,
	onCreate,
}: {
	open: boolean;
	onClose: () => void;
	// Makes it and opens it; what went wrong, shown in the dialog, or null once it is made.
	onCreate: (name: string) => Promise<string | null>;
}) {
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				onClose();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (name.trim() === '') {
							return;
						}
						setSaving(true);
						const failed = await onCreate(name.trim());
						setSaving(false);
						setError(failed);
						if (failed === null) {
							onClose();
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Create organization</DialogTitle>
						<DialogDescription>
							An organization is where you work with other people: its connections, agents and
							activity are its own. You are its owner, and invite them next. What you have in your
							other organizations stays where it is.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="org-name">Name</Label>
						<Input
							id="org-name"
							autoFocus
							autoComplete="off"
							placeholder="Acme"
							maxLength={80}
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<PillButton type="button" variant="ghost" onClick={onClose}>
							Cancel
						</PillButton>
						<PillButton type="submit" disabled={name.trim() === '' || saving}>
							{saving ? 'Creating…' : 'Create'}
						</PillButton>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
