import type {AgentLogin} from '@proxy/contracts/agents';
import {AGENT_NAME_MAX, findAgentProvider} from '@proxy/utils/agent-providers';
import {BanIcon, KeyRoundIcon, PencilIcon, RotateCcwIcon, Trash2Icon} from 'lucide-react';
import {useState} from 'react';
import {useNavigate} from 'react-router';
import {deleteAgent, renameAgent, setAgentRevoked} from '@/client/agents-client';
import {AgentLogo} from '@/components/brand-logo';
import {Badge} from '@proxy/ui/components/badge';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AddButton} from '@/components/add-button';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {RenameDialog} from '@/components/rename-dialog';
import {Row, RowHeader, RowList} from '@/components/row-list';
import {SideEmpty, SideToggle} from '@/components/share-toggle';
import {useApply} from '@/hooks/use-apply';
import {useHuman} from '@/hooks/use-human';
import {useLoaded} from '@/hooks/use-loaded';
import {useReload} from '@/hooks/use-reload';
import {useSide} from '@/hooks/use-side';
import {formatAgo} from '@/lib/format';
import {describeApiError} from '@/lib/loader-utils';
import {manages} from '@/lib/orgs';
import {cn} from '@proxy/ui/lib/utils';
import type {agentsLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	company: 'hidden w-24 shrink-0 truncate text-muted-foreground md:block',
	username: 'hidden w-52 shrink-0 truncate font-mono text-muted-foreground md:block',
	active: 'w-24 shrink-0 text-right text-muted-foreground tabular-nums',
};

// What a row's context menu is about: the agent, and whether it is being renamed, revoked or
// deleted.
type Pending = {agent: AgentLogin; action: 'rename' | 'revoke' | 'delete'};

// The agent logins in the organization open, newest first: its shared ones and the person's own,
// never another member's. With anyone else in it or invited, a toggle picks the list, in the
// address as `?for=me` or `?for=everyone`, opening on the shared one unless only the person's own
// has any. A revoked one stays listed, muted, until it is deleted. A right click on a row does
// what the agent's page header does, for an agent the person may change: renames it, and, but
// for the built-in one, sets it up again, revokes or restores its login, or deletes it.
export function AgentsPage() {
	return (
		<AppShell title={<PageTitle>External agents</PageTitle>}>
			<Agents />
		</AppShell>
	);
}

function Agents() {
	const org = useOrgSlug();
	const {agents: all} = useLoaded<typeof agentsLoader>();
	const human = useHuman();
	const navigate = useNavigate();
	const reload = useReload();
	const side = useSide(all, {opensOnShared: true});
	const [pending, setPending] = useState<Pending | null>(null);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	if (!human) {
		return null;
	}

	const activeOrg = human.org;
	const agents = side.shown;
	const renaming = pending?.action === 'rename' ? pending.agent : null;
	const revoking = pending?.action === 'revoke' ? pending.agent : null;
	const deleting = pending?.action === 'delete' ? pending.agent : null;

	return (
		<>
			<SideToggle
				side={side}
				orgName={activeOrg.name}
				add={
					<AddButton
						label="New agent"
						to={side.shared ? `/${org}/agents/new?for=everyone` : `/${org}/agents/new`}
					/>
				}
			/>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<RowList
				header={
					<RowHeader>
						<span className="size-5 shrink-0" />
						<span className="min-w-0 flex-1">Agent</span>
						<span className={CELLS.company}>Company</span>
						<span className={CELLS.username}>Username</span>
						<span className={CELLS.active}>Last active</span>
					</RowHeader>
				}
			>
				{agents.length === 0 && (
					<SideEmpty
						side={side}
						alone="No agents yet."
						shared={`No agent shared with ${activeOrg.name} yet.`}
						own={`No agent of your own in ${activeOrg.name} yet.`}
					/>
				)}
				{agents.map((agent) => {
					const revoked = agent.revokedAt !== null;
					const provider = findAgentProvider(agent.providerId);
					const builtIn = provider?.connects === 'built-in';
					return (
						<Row
							key={agent.id}
							to={`/${org}/agents/${agent.id}`}
							icon={<AgentLogo providerId={agent.providerId} />}
							title={
								<span
									className={cn(
										'inline-flex items-center gap-2',
										revoked && 'text-muted-foreground',
									)}
								>
									<span>
										{agent.name}
										{revoked && ' · Revoked'}
									</span>
									{builtIn && <Badge variant="secondary">Built in</Badge>}
								</span>
							}
							cells={
								<>
									<span className={CELLS.company}>{provider?.company ?? agent.providerId}</span>
									{builtIn ? (
										<span className={cn(CELLS.username, 'font-sans')}>
											The agents on the Chat page
										</span>
									) : (
										<span className={CELLS.username}>{agent.username}</span>
									)}
									<span className={CELLS.active}>
										{agent.lastActiveAt ? formatAgo(agent.lastActiveAt) : 'Never'}
									</span>
								</>
							}
							menu={
								manages(human, agent) && (
									<>
										<ContextMenuItem onClick={() => setPending({agent, action: 'rename'})}>
											<PencilIcon />
											Rename
										</ContextMenuItem>
										{!builtIn && !revoked && (
											<ContextMenuItem onClick={() => navigate(`/${org}/agents/${agent.id}/setup`)}>
												<KeyRoundIcon />
												Set up again
											</ContextMenuItem>
										)}
										{!builtIn && revoked && (
											<ContextMenuItem
												onClick={() => void apply(setAgentRevoked(org, agent.id, false))}
											>
												<RotateCcwIcon />
												Restore login
											</ContextMenuItem>
										)}
										{!builtIn && !revoked && (
											<ContextMenuItem onClick={() => setPending({agent, action: 'revoke'})}>
												<BanIcon />
												Revoke login
											</ContextMenuItem>
										)}
										{!builtIn && (
											<ContextMenuItem
												variant="destructive"
												onClick={() => setPending({agent, action: 'delete'})}
											>
												<Trash2Icon />
												Delete
											</ContextMenuItem>
										)}
									</>
								)
							}
						/>
					);
				})}
			</RowList>
			{renaming && (
				<RenameDialog
					key={renaming.id}
					open
					title={`Rename ${renaming.name}`}
					description="What this agent is called here, in the activity log and to the agent itself."
					initial={renaming.name}
					allowEmpty={false}
					maxLength={AGENT_NAME_MAX}
					onClose={() => setPending(null)}
					onSave={async (name) => {
						const result = await renameAgent(org, renaming.id, name);
						if (result.isErr()) {
							return describeApiError(result.error);
						}
						await reload();
						return null;
					}}
				/>
			)}
			<ConfirmDialog
				open={revoking !== null}
				title={revoking ? `Revoke ${revoking.name}?` : ''}
				description="The agent is signed out and cannot sign in again. Its access stays as it is, so restoring the login brings it back unchanged."
				confirmLabel="Revoke"
				destructive
				onClose={() => setPending(null)}
				onConfirm={() => {
					if (!revoking) {
						return;
					}
					void apply(setAgentRevoked(org, revoking.id, true));
				}}
			/>
			<ConfirmDialog
				open={deleting !== null}
				title={deleting ? `Delete ${deleting.name}?` : ''}
				description="The login and its access are gone for good. Its lines in the activity log stay."
				confirmLabel="Delete"
				destructive
				onClose={() => setPending(null)}
				onConfirm={() => {
					if (!deleting) {
						return;
					}
					void apply(deleteAgent(org, deleting.id));
				}}
			/>
		</>
	);
}
