import {useState} from 'react';
import {useRouteLoaderData} from 'react-router';
import {deleteAccount, type Me} from '@/client/me-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {DeleteAccountDialog} from '@/components/delete-account-dialog';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Button} from '@proxy/ui/components/button';
import {describeFetchError} from '@/lib/loader-utils';

// The account itself: who is signed in, and deleting the account with everything in it.
export function SettingsPage() {
	const me = useRouteLoaderData<Me>('human');
	const [deleting, setDeleting] = useState(false);
	if (!me) {
		return null;
	}

	return (
		<AppShell title={<PageTitle>Settings</PageTitle>}>
			<div className="flex flex-col gap-8">
				<Section title="Account">
					<RowList>
						<AccountRow label="Email" value={me.user.email} />
						{me.user.name && <AccountRow label="Name" value={me.user.name} />}
					</RowList>
				</Section>
				<Section
					title="Delete account"
					action={
						<Button size="xs" variant="destructive" onClick={() => setDeleting(true)}>
							Delete account
						</Button>
					}
				>
					<p className="text-sm text-muted-foreground md:px-3">
						Disconnects every connection, at its provider too where it has a way, as Google's access
						is revoked, and deletes your information, agents and their activity.
					</p>
				</Section>
			</div>
			<DeleteAccountDialog
				key={String(deleting)}
				open={deleting}
				email={me.user.email}
				onClose={() => setDeleting(false)}
				onDelete={async () => {
					const result = await deleteAccount();
					if (result.isErr()) {
						return describeFetchError(result.error);
					}
					// A full load, so nothing of the account stays in memory; the login page is next.
					window.location.assign('/login');
					return null;
				}}
			/>
		</AppShell>
	);
}

function AccountRow({label, value}: {label: string; value: string}) {
	return (
		<li className="flex h-10 min-w-0 items-center gap-3 px-4 text-sm md:px-3">
			<span className="w-24 shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 flex-1 truncate">{value}</span>
		</li>
	);
}
