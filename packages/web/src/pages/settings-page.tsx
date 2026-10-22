import type {FetchError} from '@proxy/utils';
import {PencilIcon} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {Link, useNavigate, useRevalidator} from 'react-router';
import {deleteAccount} from '@/client/me-client';
import {deleteOrg, renameOrg, type Org} from '@/client/orgs-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {IconButton} from '@/components/icon-button';
import {OrgTile} from '@/components/org-switcher';
import {RenameDialog} from '@/components/rename-dialog';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {TypeToConfirmDialog} from '@/components/type-to-confirm-dialog';
import {Button} from '@proxy/ui/components/button';
import {useHuman} from '@/hooks/use-human';
import {apiMessage} from '@/lib/agent-errors';
import {describeFetchError} from '@/lib/loader-utils';
import {hasOtherPeople, ownedOrgs} from '@/lib/orgs';

type Deleting = 'account' | 'org' | null;

// What the api said went wrong, in its words where it has them.
function failureOf(error: FetchError): string {
	const said = error.kind === 'http' ? apiMessage(error.body) : null;
	return said ?? describeFetchError(error);
}

// The account and the organization open in the switcher: who is signed in, the organization's
// name and your place in it, and deleting either. An organization's owner renames and deletes it,
// unless it is the last one they own; deleting the account deletes every one they own.
export function SettingsPage() {
	const me = useHuman();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [deleting, setDeleting] = useState<Deleting>(null);
	const [renaming, setRenaming] = useState(false);
	if (!me) {
		return null;
	}

	const org = me.org;
	const owner = org.role === 'owner';
	const owned = ownedOrgs(me.orgs);
	const lastOwned = owned.length <= 1;
	// The organizations deleted with the account that others are in or invited to.
	const shared = owned.filter(hasOtherPeople);

	return (
		<AppShell title={<PageTitle>Settings</PageTitle>}>
			<div className="flex flex-col gap-8">
				<Section title="Account">
					<RowList>
						<SettingRow label="Email">{me.user.email}</SettingRow>
						{me.user.name && <SettingRow label="Name">{me.user.name}</SettingRow>}
					</RowList>
				</Section>
				<Section title="Organization" detail="the one open in the switcher">
					<RowList>
						<SettingRow
							label="Name"
							action={
								owner && (
									<IconButton label="Rename organization" onClick={() => setRenaming(true)}>
										<PencilIcon />
									</IconButton>
								)
							}
						>
							<span className="flex items-center gap-2">
								<OrgTile org={org} />
								{org.name}
							</span>
						</SettingRow>
						<SettingRow label="Your role">{owner ? 'Owner' : 'Member'}</SettingRow>
						<SettingRow label="Members">
							<Link to={`/${org.slug}/members`} className="underline underline-offset-4">
								{org.memberCount} {org.memberCount === 1 ? 'member' : 'members'}
							</Link>
						</SettingRow>
					</RowList>
				</Section>
				{owner && (
					<DangerCard
						title={`Delete ${org.name}`}
						description={
							lastOwned
								? 'This is the only organization you own. Create another first, or delete your account instead.'
								: 'Its connections are first invalidated at the provider (where possible), then deleted with its vault, agents and activity. Everyone in it loses it. This cannot be undone.'
						}
						button="Delete organization"
						disabled={lastOwned}
						onClick={() => setDeleting('org')}
					/>
				)}
				<DangerCard
					title="Delete account"
					description={`${deletedWith(shared)} You leave the organizations you don't own. Every connection deleted is first invalidated at the provider (where possible), then deleted with its vault, agents and activity. This cannot be undone.`}
					button="Delete account"
					onClick={() => setDeleting('account')}
				/>
			</div>
			{renaming && (
				<RenameDialog
					key={org.id}
					open
					title={`Rename ${org.name}`}
					description="What everyone in it sees, in the switcher and on Members."
					initial={org.name}
					allowEmpty={false}
					onClose={() => setRenaming(false)}
					onSave={async (name) => {
						const result = await renameOrg(org.slug, name);
						if (result.isErr()) {
							return failureOf(result.error);
						}
						await revalidator.revalidate();
						return null;
					}}
				/>
			)}
			<TypeToConfirmDialog
				key={`org-${String(deleting === 'org')}`}
				open={deleting === 'org'}
				title={`Delete ${org.name}?`}
				description="Its connections are invalidated at the provider and deleted, with its vault, agents and activity. Everyone in it loses it. This cannot be undone."
				word={org.name}
				confirmLabel="Delete organization"
				onClose={() => setDeleting(null)}
				onConfirm={async () => {
					const result = await deleteOrg(org.slug);
					if (result.isErr()) {
						return failureOf(result.error);
					}
					setDeleting(null);
					// Gone, the person's first other organization: they own another, or it wouldn't go.
					const next = me.orgs.find((candidate) => candidate.id !== org.id) ?? org;
					await navigate(`/${next.slug}/connections?deleted=${encodeURIComponent(org.name)}`);
					return null;
				}}
			/>
			<TypeToConfirmDialog
				key={`account-${String(deleting === 'account')}`}
				open={deleting === 'account'}
				title="Delete your account?"
				description={`${deletedWith(shared)} You leave the others. Every connection deleted is first invalidated at the provider (where possible), then deleted with its vault, agents and activity. This cannot be undone.`}
				word={me.user.email}
				confirmLabel="Delete account"
				onClose={() => setDeleting(null)}
				onConfirm={async () => {
					const result = await deleteAccount();
					if (result.isErr()) {
						return failureOf(result.error);
					}
					// A full load, so nothing of the account stays in memory; the login page is next.
					window.location.assign('/login');
					return null;
				}}
			/>
		</AppShell>
	);
}

// What deleting the account deletes beside it: the organizations the person owns, naming those
// others are in, who lose them too.
function deletedWith(shared: Org[]): string {
	if (shared.length === 0) {
		return 'The organizations you own are deleted with it.';
	}
	return `The organizations you own are deleted with it, everything in them included, for everyone in them: ${shared.map((org) => org.name).join(', ')}.`;
}

function SettingRow({
	label,
	action,
	children,
}: {
	label: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<li className="bleed flex h-10 min-w-0 items-center gap-3 text-sm">
			<span className="w-24 shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{action}
		</li>
	);
}

// Something that can't be undone, in red: what it does, and its button; disabled, the description
// says what has to happen first.
function DangerCard({
	title,
	description,
	button,
	disabled,
	onClick,
}: {
	title: string;
	description: string;
	button: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<section className="overflow-hidden rounded-xl border border-destructive/40">
			<div className="grid gap-1 p-4">
				<h2 className="text-sm font-medium">{title}</h2>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<div className="flex justify-end border-t border-destructive/40 bg-destructive/5 px-4 py-3">
				<Button
					className="bg-destructive text-white hover:bg-destructive/90"
					disabled={disabled}
					onClick={onClick}
				>
					{button}
				</Button>
			</div>
		</section>
	);
}
