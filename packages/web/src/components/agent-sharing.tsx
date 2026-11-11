import type {AgentLogin} from '@proxy/contracts/agents';
import type {Member} from '@proxy/contracts/orgs';
import {UsersIcon} from 'lucide-react';
import {useState} from 'react';
import {Link} from 'react-router';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {PersonAvatar} from '@/components/person-avatar';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {PillButton} from '@/components/pill-button';
import {useOrgSlug} from '@/hooks/use-org';

type Props = {
	orgName: string;
	agent: AgentLogin;
	// The organization's members, for who its people are.
	members: Member[];
	// The person looking, among them.
	userId: string;
	// Theirs to share; else they see who has it, and nothing more.
	mayChange: boolean;
	// Nobody else is in the organization or invited: there is no one to share with yet.
	alone: boolean;
	onShare: () => Promise<void>;
};

// A person on the list: a member, or the little the agent says of someone the members' list no
// longer has.
type Person = {userId: string; name: string | null; email: string; image: string | null};

const ROW = 'bleed flex min-h-12 items-center gap-3 py-1.5 text-sm';
const DETAIL = 'hidden min-w-0 shrink truncate text-muted-foreground md:block';

function nameOf(person: Person): string {
	return person.name ?? person.email;
}

// The Sharing part of an agent's page, in an organization with other people in it, as a
// connection's is (connection-sharing.tsx): a line on who sees the agent and what it reaches, and
// the people with access. One's own is the person's alone, with a button that shares it with
// every member, which asks first, since sharing an agent is for good; a shared one is everyone's,
// and says who made it, who changes it with the organization's owner. Alone in the organization,
// it points to Members instead.
export function AgentSharing({orgName, agent, members, userId, mayChange, alone, onShare}: Props) {
	const org = useOrgSlug();
	const [confirming, setConfirming] = useState(false);

	if (alone) {
		return (
			<p className="text-sm text-muted-foreground">
				<Link to={`/${org}/members`} className="text-foreground underline underline-offset-4">
					Invite people
				</Link>{' '}
				to {orgName} to share agents with them.
			</p>
		);
	}

	// One's own agent is seen by nobody else, so whoever looks at it is whose it is.
	const ownerId = agent.shared ? agent.createdById : userId;
	const found = members.find((member) => member.userId === ownerId);
	const maker: Person | null =
		found ??
		(agent.shared && agent.createdById !== null
			? {
					userId: agent.createdById,
					name: agent.createdBy ?? 'A former member',
					email: '',
					image: null,
				}
			: null);

	return (
		<div className="flex flex-col gap-6">
			<p className="text-sm text-muted-foreground">
				{agent.shared
					? `Everyone in ${orgName} sees ${agent.name} and can give its login to their own tools. It reaches only the connections shared with everyone.`
					: `Only you see ${agent.name}. It reaches your connections and those shared with you.`}
			</p>
			<Section title="People with access">
				<RowList>
					{maker && (
						<li className={ROW}>
							<PersonAvatar person={maker} />
							<span className="min-w-0 flex-1 truncate">
								{nameOf(maker)}
								{maker.userId === userId && <span className="text-muted-foreground"> · You</span>}
							</span>
							{maker.name !== null && <span className={DETAIL}>{maker.email}</span>}
							<span className="w-20 shrink-0 text-right text-muted-foreground">
								{agent.shared ? 'Made it' : 'Owner'}
							</span>
						</li>
					)}
					{(agent.shared || mayChange) && (
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
									{agent.shared
										? 'Every member has it. Whoever made it and the organization’s owner change it'
										: 'Every member, now and later, for good'}
								</span>
							</span>
							{!agent.shared && (
								<PillButton variant="ghost" onClick={() => setConfirming(true)}>
									Share with everyone
								</PillButton>
							)}
						</li>
					)}
				</RowList>
			</Section>
			<ConfirmDialog
				open={confirming}
				title={`Share it with everyone in ${orgName}?`}
				description={`Everyone in ${orgName} sees ${agent.name} and can give its login to their own tools. It reaches only the connections shared with everyone from then on, so its settings on any other are dropped. Its tasks and activity so far become everyone's too, except what it did on any other connection, which stays yours. Whoever made it and the organization's owner change it. This can't be undone.`}
				confirmLabel="Share"
				onClose={() => setConfirming(false)}
				onConfirm={() => void onShare()}
			/>
		</div>
	);
}
