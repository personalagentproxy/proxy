import type {Connection} from '@proxy/contracts/connections';
import type {Member} from '@proxy/contracts/orgs';
import {PlusIcon, UsersIcon} from 'lucide-react';
import {useState} from 'react';
import {Link} from 'react-router';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {PersonAvatar} from '@/components/person-avatar';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Button} from '@proxy/ui/components/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@proxy/ui/components/dropdown-menu';
import {useOrgSlug} from '@/hooks/use-org';

/** Who a connection is shared with: every member of its organization, and the members named. */
export type SharingChoice = {everyone: boolean; userIds: string[]};

type Props = {
	orgName: string;
	connection: Connection;
	// What it is called in the texts: 'connection', or 'vault'.
	what: string;
	// The organization's members, for who its people are and whom it can be shared with by name.
	members: Member[];
	// The person looking, among them.
	userId: string;
	// Who the provider sees when an agent uses it; null for a vault, which is kept here, so there
	// is no provider to see anyone.
	actsAs: string | null;
	// What acting through it means for whose name it is done in, where the integration says
	// (`sharingWarning`): shown beside who has it, and asked about before sharing it.
	warning?: string;
	// Theirs to share and take back; else they see who uses it, and nothing more.
	mayChange: boolean;
	// Nobody else is in the organization or invited: there is no one to share with yet.
	alone: boolean;
	onChange: (sharing: SharingChoice) => Promise<void>;
};

// A person on the list: a member, or the little the connection says of someone the members' list
// no longer has.
type Person = {userId: string; name: string | null; email: string; image: string | null};

const ROW = 'bleed flex min-h-12 items-center gap-3 py-1.5 text-sm';
const DETAIL = 'hidden min-w-0 shrink truncate text-muted-foreground md:block';

function nameOf(person: Person): string {
	return person.name ?? person.email;
}

// The Sharing part of a connection's page, in an organization with other people in it: a line on
// what sharing hands over, the people with access, whoever's it is first, and whether every member
// has it. Whoever may change it adds a member from a menu of those who don't have it yet, which
// asks first, since their agents then act as the account, and removes one with a button, at once;
// sharing with everyone is a button of its own, asked about the same way. Anyone else it is shared
// with sees who has it and changes nothing. Alone in the organization, it points to Members
// instead.
export function ConnectionSharing({
	orgName,
	connection,
	what,
	members,
	userId,
	actsAs,
	warning,
	mayChange,
	alone,
	onChange,
}: Props) {
	const org = useOrgSlug();
	// Whom it is about to be shared with, asked about first: everyone, or one member.
	const [asking, setAsking] = useState<'everyone' | Person | null>(null);
	const [saving, setSaving] = useState(false);

	if (alone) {
		return (
			<p className="text-sm text-muted-foreground">
				<Link to={`/${org}/members`} className="text-foreground underline underline-offset-4">
					Invite people
				</Link>{' '}
				to {orgName} to share {what}s with them.
			</p>
		);
	}

	const person = (id: string, name: string | null): Person =>
		members.find((member) => member.userId === id) ?? {userId: id, name, email: '', image: null};
	const owner = person(connection.ownerUserId, connection.owner ?? 'A former member');
	const named = connection.sharedWith.map((shared) => person(shared.userId, shared.name));
	const namedIds = named.map((shared) => shared.userId);
	const addable = members.filter(
		(member) => member.userId !== owner.userId && !namedIds.includes(member.userId),
	);
	const save = async (sharing: SharingChoice) => {
		setSaving(true);
		await onChange(sharing);
		setSaving(false);
	};
	const {sharedWithEveryone: everyone} = connection;
	const askedName = asking === null || asking === 'everyone' ? '' : nameOf(asking);
	// What sharing hands over, after who gets it: the account its agents then act as, or a vault's
	// entries.
	const handsOver =
		actsAs === null
			? 'can read it and keep what they learn in it, with what Permissions allows'
			: `can use it, as ${actsAs}, with what Permissions allows`;
	const seen = actsAs === null ? 'listed, with its entries' : 'listed, never its password or token';

	return (
		<div className="flex flex-col gap-6">
			<p className="text-sm text-muted-foreground">
				{actsAs !== null && (
					<>
						Agents use this {what} as <span className="text-foreground">{actsAs}</span>.{' '}
					</>
				)}
				{mayChange
					? `The people you share it with use it through their own agents. They can’t change it or share it on.`
					: `You use it through your own agents. Only ${nameOf(owner)} changes it or shares it on.`}
			</p>
			{warning && <p className="text-sm">{warning}</p>}
			<Section
				title="People with access"
				action={
					mayChange &&
					addable.length > 0 && (
						<DropdownMenu>
							<DropdownMenuTrigger
								render={<Button variant="outline" size="sm" disabled={saving} />}
							>
								<PlusIcon data-icon="inline-start" />
								Add people
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-72">
								{addable.map((member) => (
									<DropdownMenuItem key={member.userId} onClick={() => setAsking(member)}>
										<PersonAvatar person={member} className="size-6" />
										<span className="min-w-0 flex-1 truncate">{nameOf(member)}</span>
										{member.name !== null && (
											<span className="min-w-0 shrink truncate text-muted-foreground">
												{member.email}
											</span>
										)}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					)
				}
			>
				<RowList>
					<li className={ROW}>
						<PersonAvatar person={owner} />
						<span className="min-w-0 flex-1 truncate">
							{nameOf(owner)}
							{owner.userId === userId && <span className="text-muted-foreground"> · You</span>}
						</span>
						{owner.name !== null && <span className={DETAIL}>{owner.email}</span>}
						<span className="w-20 shrink-0 text-right text-muted-foreground">Owner</span>
					</li>
					{named.map((shared) => (
						<li key={shared.userId} className={ROW}>
							<PersonAvatar person={shared} />
							<span className="min-w-0 flex-1 truncate">
								{nameOf(shared)}
								{shared.userId === userId && <span className="text-muted-foreground"> · You</span>}
							</span>
							{shared.name !== null && <span className={DETAIL}>{shared.email}</span>}
							<span className="flex w-20 shrink-0 justify-end">
								{mayChange && (
									<Button
										variant="ghost"
										size="sm"
										disabled={saving}
										aria-label={`Remove ${nameOf(shared)}`}
										onClick={() =>
											void save({
												everyone,
												userIds: namedIds.filter((id) => id !== shared.userId),
											})
										}
									>
										Remove
									</Button>
								)}
							</span>
						</li>
					))}
					{(mayChange || everyone) && (
						<li className={ROW}>
							<span
								aria-hidden
								className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"
							>
								<UsersIcon className="size-3.5" />
							</span>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate">Everyone in {orgName}</span>
								<span className="truncate text-muted-foreground">
									{everyone
										? 'Every member has it, and so do the shared agents'
										: 'Every member, now and later, and the shared agents'}
								</span>
							</span>
							{mayChange && (
								<Button
									variant={everyone ? 'ghost' : 'outline'}
									size="sm"
									disabled={saving}
									onClick={() => {
										if (everyone) {
											void save({everyone: false, userIds: namedIds});
											return;
										}
										setAsking('everyone');
									}}
								>
									{everyone ? 'Stop sharing' : 'Share with everyone'}
								</Button>
							)}
						</li>
					)}
				</RowList>
			</Section>
			<ConfirmDialog
				open={asking !== null}
				title={
					asking === 'everyone'
						? `Share it with everyone in ${orgName}?`
						: `Share it with ${askedName}?`
				}
				description={[
					asking === 'everyone'
						? `Every member's agents in ${orgName} ${handsOver}. Members see it ${seen}.`
						: `${askedName}'s agents ${handsOver}. ${askedName} sees it ${seen}.`,
					warning,
					asking === 'everyone'
						? 'You can stop sharing it at any time.'
						: 'You can remove them at any time.',
				]
					.filter(Boolean)
					.join(' ')}
				confirmLabel="Share"
				onClose={() => setAsking(null)}
				onConfirm={() => {
					if (asking === null) {
						return;
					}
					void save(
						asking === 'everyone'
							? {everyone: true, userIds: namedIds}
							: {everyone, userIds: [...namedIds, asking.userId]},
					);
				}}
			/>
		</div>
	);
}
