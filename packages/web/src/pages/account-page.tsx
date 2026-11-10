import type {Session} from '@proxy/contracts/me';
import type {Org} from '@proxy/contracts/orgs';
import {
	AppWindowIcon,
	LogOutIcon,
	MonitorIcon,
	SmartphoneIcon,
	type LucideIcon,
} from 'lucide-react';
import {useState} from 'react';
import {Link} from 'react-router';
import {Button} from '@proxy/ui/components/button';
import {signOut} from '@/client/auth-client';
import {deleteAccount, deleteOtherSessions, deleteSession} from '@/client/me-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {DangerCard} from '@/components/danger-card';
import {IconButton} from '@/components/icon-button';
import {NotificationSetting} from '@/components/notification-setting';
import {OrgTile} from '@/components/org-switcher';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {SettingRow} from '@/components/setting-row';
import {ThemePicker} from '@/components/theme-picker';
import {TypeToConfirmDialog} from '@/components/type-to-confirm-dialog';
import {useApply} from '@/hooks/use-apply';
import {useHuman} from '@/hooks/use-human';
import {useLoaded} from '@/hooks/use-loaded';
import {formatDate} from '@/lib/format';
import {describeApiError} from '@/lib/loader-utils';
import {notificationSupport} from '@/lib/notifications';
import {hasOtherPeople} from '@/lib/orgs';
import type {accountLoader} from '@/loaders';

// The person's account, in no organization: who is signed in, how the app looks to them, whether
// this device tells them what the agents say while they are elsewhere (where any of their
// organizations has Chat, and the device can), the organizations they are in, each to its own
// settings, every browser and desktop app they are signed in on, each to sign out, and deleting
// the account, which deletes every one they own.
export function AccountPage() {
	return (
		<AppShell title={<PageTitle>Account</PageTitle>}>
			<Account />
		</AppShell>
	);
}

function Account() {
	const human = useHuman();
	const {sessions} = useLoaded<typeof accountLoader>();
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);

	// Everywhere: the others first, so a failure leaves this browser signed in to say so, then here.
	async function signOutAll() {
		const result = await deleteOtherSessions();
		if (result.isErr()) {
			setError(describeApiError(result.error));
			return;
		}
		await signOut();
	}
	if (!human) {
		return null;
	}

	// The organizations deleted with the account that others are in or invited to.
	const shared = human.orgs.filter((org) => org.role === 'owner' && hasOtherPeople(org));
	const chats = human.orgs.some((org) => org.experiments.includes('harness'));

	return (
		<>
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
				{chats && notificationSupport() !== 'none' && (
					<Section title="Notifications">
						<RowList>
							<SettingRow label="Messages">
								<NotificationSetting />
							</SettingRow>
						</RowList>
						<p className="text-sm text-muted-foreground">
							A notification on this device when an agent answers in Chat while you are elsewhere.
						</p>
					</Section>
				)}
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
				<Section
					title="Sessions"
					detail={sessions.length}
					action={
						sessions.some((session) => !session.current) && (
							<Button size="sm" variant="outline" onClick={() => void signOutAll()}>
								Sign out all
							</Button>
						)
					}
				>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<RowList>
						{sessions.map((session) => {
							const Icon = iconOf(session);
							return (
								<li key={session.id} className="bleed flex h-10 min-w-0 items-center gap-3 text-sm">
									<Icon className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate">
										{nameOf(session)}
										{session.current && (
											<span className="text-muted-foreground"> · {hereOf(session)}</span>
										)}
									</span>
									<span className="hidden shrink-0 text-muted-foreground tabular-nums sm:block">
										Signed in {formatDate(session.createdAt)}
									</span>
									<IconButton
										label={
											session.current
												? `Sign out of ${hereOf(session).toLowerCase()}`
												: `Sign out ${nameOf(session)}`
										}
										onClick={() => {
											if (session.current) {
												void signOut();
												return;
											}
											void apply(deleteSession(session.id));
										}}
									>
										<LogOutIcon className="rotate-180" />
									</IconButton>
								</li>
							);
						})}
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
		</>
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

// "Chrome on macOS", or as much of it as the session's User-Agent said.
function nameOf(session: Session): string {
	if (session.client && session.os) {
		return `${session.client} on ${session.os}`;
	}

	if (session.client) {
		return session.client;
	}

	if (session.os) {
		return `A browser on ${session.os}`;
	}

	return 'An unknown browser';
}

// What the session asking is called: the desktop app is no browser.
function hereOf(session: Session): string {
	return session.client === 'Desktop app' ? 'This app' : 'This browser';
}

function iconOf(session: Session): LucideIcon {
	if (session.client === 'Desktop app') {
		return AppWindowIcon;
	}

	if (session.os === 'iOS' || session.os === 'Android') {
		return SmartphoneIcon;
	}

	return MonitorIcon;
}
