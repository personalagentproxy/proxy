import {EllipsisIcon, LogOutIcon, MailPlusIcon, Trash2Icon, XIcon} from 'lucide-react';
import {useState} from 'react';
import {useLoaderData, useNavigate, useRevalidator} from 'react-router';
import {
	inviteMember,
	leaveOrg,
	removeMember,
	revokeInvitation,
	type Member,
} from '@/client/orgs-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {IconButton} from '@/components/icon-button';
import {OrgTile} from '@/components/org-switcher';
import {RowHeader, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
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
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@proxy/ui/components/dropdown-menu';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {useApply} from '@/hooks/use-apply';
import {useHuman} from '@/hooks/use-human';
import {formatDate} from '@/lib/format';
import {describeApiError} from '@/lib/loader-utils';
import {NO_PASSWORD_MANAGER} from '@/lib/password-managers';
import type {membersLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	email: 'hidden w-52 shrink-0 truncate text-muted-foreground md:block',
	role: 'w-20 shrink-0 text-muted-foreground',
	date: 'w-24 shrink-0 text-right text-muted-foreground tabular-nums',
};

// A row on the rows' text line, reaching into the gutter as a RowList's rows do.
const ROW = 'bleed flex h-10 items-center gap-3 text-sm';

// What a row's menu is about: the member, and whether they are being removed or are leaving.
type Pending = {member: Member; action: 'remove' | 'leave'};

// The people in the organization open, and the invitations not taken up yet. Its owner, whoever
// made it, invites and removes, and deletes it rather than leaving; members leave. Roles never
// change.
export function MembersPage() {
	const {members, invitations} = useLoaderData<typeof membersLoader>();
	const human = useHuman();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [inviting, setInviting] = useState(false);
	const [pending, setPending] = useState<Pending | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	if (!human) {
		return null;
	}

	const organization = human.org;
	const owner = organization.role === 'owner';
	const nameOf = (member: Member) => member.name ?? member.email;

	return (
		<AppShell
			title={
				<PageTitle detail={`${members.length} ${members.length === 1 ? 'member' : 'members'}`}>
					<span className="flex items-center gap-2">
						<OrgTile org={organization} />
						{organization.name}
					</span>
				</PageTitle>
			}
			actions={
				owner && (
					<Button size="sm" onClick={() => setInviting(true)}>
						<MailPlusIcon data-icon="inline-start" />
						Invite
					</Button>
				)
			}
		>
			<div className="flex flex-col gap-8">
				{error && <p className="text-sm text-destructive">{error}</p>}
				<Section title="Members">
					<RowList
						header={
							<RowHeader>
								<span className="size-5 shrink-0" />
								<span className="min-w-0 flex-1">Name</span>
								<span className={CELLS.email}>Email</span>
								<span className={CELLS.role}>Role</span>
								<span className={CELLS.date}>Joined</span>
								<span className="size-8 shrink-0" />
							</RowHeader>
						}
					>
						{members.map((member) => {
							const you = member.userId === human.user.id;
							return (
								<li key={member.userId} className={ROW}>
									<Initial name={nameOf(member)} />
									<span className="min-w-0 flex-1 truncate">
										{nameOf(member)}
										{you && <span className="text-muted-foreground"> · You</span>}
									</span>
									<span className={CELLS.email}>{member.email}</span>
									<span className={CELLS.role}>{member.role === 'owner' ? 'Owner' : 'Member'}</span>
									<span className={CELLS.date}>{formatDate(member.joinedAt)}</span>
									<MemberMenu
										you={you}
										name={nameOf(member)}
										owner={owner}
										onRemove={() => setPending({member, action: you ? 'leave' : 'remove'})}
									/>
								</li>
							);
						})}
					</RowList>
				</Section>
				{invitations.length > 0 && (
					<Section title="Invitations" detail={invitations.length}>
						<RowList
							header={
								<RowHeader>
									<span className="size-5 shrink-0" />
									<span className="min-w-0 flex-1">Email</span>
									<span className={CELLS.email}>Invited by</span>
									<span className={CELLS.date}>Expires</span>
									<span className="size-8 shrink-0" />
								</RowHeader>
							}
						>
							{invitations.map((invitation) => (
								<li key={invitation.id} className={ROW}>
									<Initial name={invitation.email} muted />
									<span className="min-w-0 flex-1 truncate">{invitation.email}</span>
									<span className={CELLS.email}>{invitation.invitedBy ?? 'A former member'}</span>
									<span className={CELLS.date}>{formatDate(invitation.expiresAt)}</span>
									{owner ? (
										<IconButton
											label={`Revoke the invitation to ${invitation.email}`}
											onClick={() => void apply(revokeInvitation(organization.slug, invitation.id))}
										>
											<XIcon />
										</IconButton>
									) : (
										<span className="size-8 shrink-0" />
									)}
								</li>
							))}
						</RowList>
					</Section>
				)}
				<p className="text-sm text-muted-foreground">
					Everyone in {organization.name} works with the connections and agents shared with it; each
					member's own stay theirs alone. Its owner invites people and removes members.
				</p>
			</div>
			<InviteDialog
				key={String(inviting)}
				open={inviting}
				orgName={organization.name}
				onClose={() => setInviting(false)}
				onInvite={async (email) => {
					const result = await inviteMember(organization.slug, email);
					if (result.isErr()) {
						return describeApiError(result.error);
					}
					await revalidator.revalidate();
					return null;
				}}
			/>
			<ConfirmDialog
				open={pending?.action === 'remove'}
				title={pending ? `Remove ${nameOf(pending.member)}?` : ''}
				description={
					pending
						? `${nameOf(pending.member)} loses ${organization.name} at once: its connections, agents and activity are no longer theirs to see or use, and the apps they signed in as its shared agents are signed out. The shared agents they made get a password nobody knows, and are signed out everywhere until you give them a new one; another shared agent's password they know keeps working until it is reset.`
						: ''
				}
				confirmLabel="Remove"
				destructive
				onClose={() => setPending(null)}
				onConfirm={() => {
					if (!pending) {
						return;
					}
					void apply(removeMember(organization.slug, pending.member.userId));
				}}
			/>
			<ConfirmDialog
				open={pending?.action === 'leave'}
				title={`Leave ${organization.name}?`}
				description={`You lose ${organization.name} at once: its connections, agents and activity are no longer yours to see or use. Its owner can invite you again.`}
				confirmLabel="Leave"
				destructive
				onClose={() => setPending(null)}
				onConfirm={async () => {
					const result = await leaveOrg(organization.slug);
					if (result.isErr()) {
						setError(describeApiError(result.error));
						return;
					}
					// Out of it, the person's first other organization: everyone owns one.
					const next =
						human.orgs.find((candidate) => candidate.id !== organization.id) ?? organization;
					await navigate(`/${next.slug}/connections?left=${encodeURIComponent(organization.name)}`);
				}}
			/>
		</AppShell>
	);
}

// A member's actions: leaving for a member themselves, and removing for the owner looking at
// someone else. The owner has none for themselves: they delete the organization in Settings. A
// space where there are none, so the columns stay lined up.
function MemberMenu({
	you,
	name,
	owner,
	onRemove,
}: {
	you: boolean;
	name: string;
	owner: boolean;
	onRemove: () => void;
}) {
	if (you === owner) {
		return <span className="size-8 shrink-0" />;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} />}
			>
				<EllipsisIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-48">
				{you ? (
					<DropdownMenuItem variant="destructive" onClick={onRemove}>
						<LogOutIcon />
						Leave…
					</DropdownMenuItem>
				) : (
					<DropdownMenuItem variant="destructive" onClick={onRemove}>
						<Trash2Icon />
						Remove…
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// A person's mark: the first letter of their name, on a round tile the size of a logo.
function Initial({name, muted = false}: {name: string; muted?: boolean}) {
	return (
		<span
			aria-hidden
			className={
				muted
					? 'flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed text-xs text-muted-foreground'
					: 'flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs'
			}
		>
			{name.slice(0, 1).toUpperCase()}
		</span>
	);
}

function InviteDialog({
	open,
	orgName,
	onClose,
	onInvite,
}: {
	open: boolean;
	orgName: string;
	onClose: () => void;
	// Sends it; what went wrong, shown in the dialog, or null once it is sent.
	onInvite: (email: string) => Promise<string | null>;
}) {
	const [email, setEmail] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const ready = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

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
						if (!ready) {
							return;
						}
						setSending(true);
						const failed = await onInvite(email.trim());
						setSending(false);
						setError(failed);
						if (failed === null) {
							onClose();
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Invite to {orgName}</DialogTitle>
						<DialogDescription>
							They get a link by email that signs them in and adds them as a member, working with
							the connections and agents shared with everyone in {orgName}. Your own stay yours.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="invite-recipient">Who to invite</Label>
						{/* Bitwarden fills any field it reads as an email, by its type and the words in its
						    id and label, whatever the marks say, so this one is a plain text field, named
						    without them, with the email keyboard on phones. The api checks the address. */}
						<Input
							id="invite-recipient"
							type="text"
							inputMode="email"
							autoFocus
							{...NO_PASSWORD_MANAGER}
							placeholder="name@company.com"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={!ready || sending}>
							{sending ? 'Sending…' : 'Send invitation'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
