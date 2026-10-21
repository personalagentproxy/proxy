import {CheckIcon, ChevronsUpDownIcon, PlusIcon} from 'lucide-react';
import {useState} from 'react';
import {useNavigate, useRevalidator} from 'react-router';
import {createOrg, setActiveOrg} from '@/client/orgs-client';
import {Button} from '@proxy/ui/components/button';
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
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@proxy/ui/components/dropdown-menu';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {SidebarMenuButton, useSidebar} from '@proxy/ui/components/sidebar';
import {cn} from '@proxy/ui/lib/utils';
import {useHuman} from '@/hooks/use-human';
import {apiMessage} from '@/lib/agent-errors';
import {describeFetchError} from '@/lib/loader-utils';
import {activeOrgOf} from '@/lib/orgs';

// An organization's mark: its initial on a tile the size of an integration's logo.
export function OrgTile({org, className}: {org: {name: string}; className?: string}) {
	return (
		<span
			aria-hidden
			className={cn(
				'flex size-5 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-medium text-primary-foreground',
				className,
			)}
		>
			{org.name.slice(0, 1).toUpperCase()}
		</span>
	);
}

// The top of the sidebar's rail: the organization the human side works in, as its mark. Hovering
// it, or clicking it on a touch screen, opens the switcher beside the rail. Everything on the human
// side is the open organization's; switching opens Home, every page's data loaded again for it.
export function OrgSwitcher() {
	const human = useHuman();
	const {isMobile, setOpenMobile} = useSidebar();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [creating, setCreating] = useState(false);
	if (!human) {
		return null;
	}

	const activeOrg = activeOrgOf(human);
	const open = async (orgId: string) => {
		setOpenMobile(false);
		if (orgId !== activeOrg.id) {
			await setActiveOrg(orgId);
		}
		await navigate('/');
		await revalidator.revalidate();
	};

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					openOnHover
					delay={100}
					closeDelay={200}
					render={<SidebarMenuButton aria-label={`Organization: ${activeOrg.name}`} />}
				>
					<OrgTile org={activeOrg} />
					<span className="min-w-0 flex-1 truncate">{activeOrg.name}</span>
					<ChevronsUpDownIcon className="ml-auto text-muted-foreground" />
				</DropdownMenuTrigger>
				{/* Beside the rail; below the switcher on a phone, where the sidebar is a full panel. */}
				<DropdownMenuContent
					side={isMobile ? 'bottom' : 'right'}
					align="start"
					sideOffset={isMobile ? 4 : 8}
					className="w-64"
				>
					<DropdownMenuGroup>
						{human.orgs.map((org) => (
							<DropdownMenuItem key={org.id} onClick={() => void open(org.id)}>
								<OrgTile org={org} />
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
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => setCreating(true)}>
						<PlusIcon />
						Create organization…
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
						const said = result.error.kind === 'http' ? apiMessage(result.error.body) : null;
						return said ?? describeFetchError(result.error);
					}
					await open(result.value.id);
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
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={name.trim() === '' || saving}>
							{saving ? 'Creating…' : 'Create'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
