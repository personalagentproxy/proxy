import {useState} from 'react';
import {Link} from 'react-router';
import {deleteAccount} from '@/client/me-client';
import type {Org} from '@/client/orgs-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {DangerCard} from '@/components/danger-card';
import {OrgTile} from '@/components/org-switcher';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {SettingRow} from '@/components/setting-row';
import {ThemePicker} from '@/components/theme-picker';
import {TypeToConfirmDialog} from '@/components/type-to-confirm-dialog';
import {useHuman} from '@/hooks/use-human';
import {describeApiError} from '@/lib/loader-utils';
import {hasOtherPeople} from '@/lib/orgs';

// The person's account, in no organization: who is signed in, how the app looks to them, the
// organizations they are in, each to its own settings, and deleting the account, which deletes
// every one they own.
export function AccountPage() {
	const human = useHuman();
	const [deleting, setDeleting] = useState(false);
	if (!human) {
		return null;
	}

	// The organizations deleted with the account that others are in or invited to.
	const shared = human.orgs.filter((org) => org.role === 'owner' && hasOtherPeople(org));

	return (
		<AppShell title={<PageTitle>Account</PageTitle>}>
			<div className="flex flex-col gap-8">
				<Section title="Profile">
					<RowList>
						<SettingRow label="Email">{human.user.email}</SettingRow>
						{human.user.name && <SettingRow label="Name">{human.user.name}</SettingRow>}
					</RowList>
				</Section>
				<Section title="Appearance">
					<RowList>
						<SettingRow label="Theme">
							<ThemePicker />
						</SettingRow>
					</RowList>
				</Section>
				<Section title="Organizations" detail={human.orgs.length}>
					<RowList>
						{human.orgs.map((org) => (
							<li key={org.id} className="bleed flex h-10 min-w-0 items-center gap-3 text-sm">
								<OrgTile org={org} />
								<Link
									to={`/${org.slug}/settings`}
									className="min-w-0 flex-1 truncate underline-offset-4 hover:underline"
								>
									{org.name}
								</Link>
								<span className="shrink-0 text-muted-foreground">
									{org.role === 'owner' ? 'Owner' : 'Member'}
								</span>
							</li>
						))}
					</RowList>
				</Section>
				<DangerCard
					title="Delete account"
					description={`${deletedWith(shared)} You leave the organizations you don't own. Every connection deleted is first invalidated at the provider (where possible), then deleted with its vault, agents and activity. This cannot be undone.`}
					button="Delete account"
					onClick={() => setDeleting(true)}
				/>
			</div>
			<TypeToConfirmDialog
				key={String(deleting)}
				open={deleting}
				title="Delete your account?"
				description={`${deletedWith(shared)} You leave the others. Every connection deleted is first invalidated at the provider (where possible), then deleted with its vault, agents and activity. This cannot be undone.`}
				word={human.user.email}
				confirmLabel="Delete account"
				onClose={() => setDeleting(false)}
				onConfirm={async () => {
					const result = await deleteAccount();
					if (result.isErr()) {
						return describeApiError(result.error);
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
