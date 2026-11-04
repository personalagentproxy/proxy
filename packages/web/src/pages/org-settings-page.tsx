import {PencilIcon} from 'lucide-react';
import {useState} from 'react';
import {Link, useNavigate, useRevalidator} from 'react-router';
import {deleteOrg, leaveOrg, renameOrg} from '@/client/orgs-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {DangerCard} from '@/components/danger-card';
import {IconButton} from '@/components/icon-button';
import {OrgTile} from '@/components/org-switcher';
import {RenameDialog} from '@/components/rename-dialog';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {SettingRow} from '@/components/setting-row';
import {TypeToConfirmDialog} from '@/components/type-to-confirm-dialog';
import {useHuman} from '@/hooks/use-human';
import {describeApiError} from '@/lib/loader-utils';

// The settings of the organization the address names: its name and your place in it. Its owner
// renames and deletes it, unless it is the last one they own; a member leaves it.
export function OrgSettingsPage() {
	const human = useHuman();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [deleting, setDeleting] = useState(false);
	const [leaving, setLeaving] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!human) {
		return null;
	}

	const organization = human.org;
	const owner = organization.role === 'owner';
	const lastOwned = human.orgs.filter((candidate) => candidate.role === 'owner').length <= 1;
	// Out of it, the person's first other organization: everyone owns one, and an owner deleting
	// it owns another, or it wouldn't go.
	const next = human.orgs.find((candidate) => candidate.id !== organization.id) ?? organization;

	return (
		<AppShell title={<PageTitle detail={organization.name}>Settings</PageTitle>}>
			<div className="flex flex-col gap-8">
				{error && <p className="text-sm text-destructive">{error}</p>}
				<Section title="Organization">
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
								<OrgTile org={organization} />
								{organization.name}
							</span>
						</SettingRow>
						<SettingRow label="Your role">{owner ? 'Owner' : 'Member'}</SettingRow>
						<SettingRow label="Members">
							<Link to={`/${organization.slug}/members`} className="underline underline-offset-4">
								{organization.memberCount} {organization.memberCount === 1 ? 'member' : 'members'}
							</Link>
						</SettingRow>
					</RowList>
				</Section>
				{owner && (
					<DangerCard
						title={`Delete ${organization.name}`}
						description={
							lastOwned
								? 'This is the only organization you own. Create another first, or delete your account instead.'
								: 'Its connections are first invalidated at the provider (where possible), then deleted with its vault, agents and activity. Everyone in it loses it. This cannot be undone.'
						}
						button="Delete organization"
						disabled={lastOwned}
						onClick={() => setDeleting(true)}
					/>
				)}
				{!owner && (
					<DangerCard
						title={`Leave ${organization.name}`}
						description="What you connected for yourself there is disconnected and your own agents there are deleted; the shared connections and agents stay. Its owner can invite you again."
						button="Leave organization"
						onClick={() => setLeaving(true)}
					/>
				)}
			</div>
			{renaming && (
				<RenameDialog
					key={organization.id}
					open
					title={`Rename ${organization.name}`}
					description="What everyone in it sees, in the switcher and on Members."
					initial={organization.name}
					allowEmpty={false}
					onClose={() => setRenaming(false)}
					onSave={async (name) => {
						const result = await renameOrg(organization.slug, name);
						if (result.isErr()) {
							return describeApiError(result.error);
						}
						await revalidator.revalidate();
						return null;
					}}
				/>
			)}
			<TypeToConfirmDialog
				key={String(deleting)}
				open={deleting}
				title={`Delete ${organization.name}?`}
				description="Its connections are invalidated at the provider and deleted, with its vault, agents and activity. Everyone in it loses it. This cannot be undone."
				word={organization.name}
				confirmLabel="Delete organization"
				onClose={() => setDeleting(false)}
				onConfirm={async () => {
					const result = await deleteOrg(organization.slug);
					if (result.isErr()) {
						return describeApiError(result.error);
					}
					setDeleting(false);
					await navigate(
						`/${next.slug}/connections?deleted=${encodeURIComponent(organization.name)}`,
					);
					return null;
				}}
			/>
			<ConfirmDialog
				open={leaving}
				title={`Leave ${organization.name}?`}
				description={`You lose ${organization.name} at once: its connections, agents and activity are no longer yours to see or use. Its owner can invite you again.`}
				confirmLabel="Leave"
				destructive
				onClose={() => setLeaving(false)}
				onConfirm={async () => {
					const result = await leaveOrg(organization.slug);
					if (result.isErr()) {
						setError(describeApiError(result.error));
						return;
					}
					await navigate(`/${next.slug}/connections?left=${encodeURIComponent(organization.name)}`);
				}}
			/>
		</AppShell>
	);
}
