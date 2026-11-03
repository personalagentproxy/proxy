import type {AgentLogin, McpClient} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {AGENT_NAME_MAX, findAgentProvider} from '@proxy/utils/agent-providers';
import type {FetchError} from '@proxy/utils';
import {
	BanIcon,
	ChevronRightIcon,
	KeyRoundIcon,
	PencilIcon,
	RotateCcwIcon,
	SearchIcon,
	Trash2Icon,
	UnplugIcon,
} from 'lucide-react';
import {useState} from 'react';
import {Link, useLoaderData, useNavigate, useParams, useRevalidator} from 'react-router';
import type {Result} from 'ts-results-es';
import {
	deleteAgent,
	disconnectMcpClient,
	renameAgent,
	setAgentGrants,
	setAgentRevoked,
	shareAgent,
} from '@/client/agents-client';
import {setConnectionDefaults} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {BackButton} from '@/components/back-button';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {ConnectionAccess} from '@/components/connection-access';
import {IconButton} from '@/components/icon-button';
import {NotFound} from '@/components/not-found';
import {RenameDialog} from '@/components/rename-dialog';
import {EmptyRows, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Sharing} from '@/components/sharing';
import {Checkbox} from '@proxy/ui/components/checkbox';
import {Input} from '@proxy/ui/components/input';
import {useApply} from '@/hooks/use-apply';
import {useHuman} from '@/hooks/use-human';
import {connectionLabel, defaultActions, integrationOf, ownSettings} from '@/lib/access';
import {cn} from '@proxy/ui/lib/utils';
import {formatDate} from '@/lib/format';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {hasOtherPeople, manages} from '@/lib/orgs';
import type {agentLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

const RECENT = 10;

type Confirming = 'revoke' | 'delete' | null;

// One agent login: what it can reach, and what it did. Handing it its login is setup's
// (`/agents/:id/setup`), done once. A shared agent is changed by whoever made it and the
// organization's owner; everyone else sees it as it is. Keyed by the agent, so the access filter
// and what is folded out start over for each.
export function AgentPage() {
	const {id = ''} = useParams();
	return <AgentDetail key={id} id={id} />;
}

function AgentDetail({id}: {id: string}) {
	const org = useOrgSlug();
	const {agent, connections, agents, entries, tasks, mcpClients} =
		useLoaderData<typeof agentLoader>();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [confirming, setConfirming] = useState<Confirming>(null);
	const [renaming, setRenaming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const human = useHuman();
	if (!agent || agent.id !== id || !human) {
		return <NotFound what="agent" back={`/${org}/agents`} backLabel="Back to agents" />;
	}

	const revoked = agent.revokedAt !== null;
	const activeOrg = human.org;
	const mayChange = manages(human, agent);
	const createdBy =
		!agent.shared || agent.createdById === human.user.id
			? 'You'
			: (agent.createdBy ?? 'A former member');
	// A shared agent reaches the connections shared with everyone alone.
	const reachable = agent.shared
		? connections.filter((connection) => connection.shared)
		: connections;
	const provider = findAgentProvider(agent.providerId);
	const company = provider?.company ?? agent.providerId;
	// A built-in agent has no login to hand out: it runs in Personal Agent Proxy itself.
	const builtIn = provider?.connects === 'built-in';

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/${org}/agents`} label="Back to agents" />
					<PageTitle
						detail={
							builtIn
								? 'Built in · the agents on the Chat page act through it, with its access'
								: revoked
									? `${company} · revoked ${formatDate(agent.revokedAt ?? '')}`
									: `${company} · added ${formatDate(agent.createdAt)}`
						}
					>
						<span className="flex items-center gap-2">
							<AgentLogo providerId={agent.providerId} />
							{agent.name}
						</span>
					</PageTitle>
				</>
			}
			actions={
				mayChange && (
					<>
						<IconButton label="Rename agent" onClick={() => setRenaming(true)}>
							<PencilIcon />
						</IconButton>
						{!revoked && !builtIn && (
							<IconButton label="Set up again" to={`/${org}/agents/${agent.id}/setup`}>
								<KeyRoundIcon />
							</IconButton>
						)}
						{builtIn ? null : revoked ? (
							<IconButton
								label="Restore login"
								onClick={() => void apply(setAgentRevoked(org, agent.id, false))}
							>
								<RotateCcwIcon />
							</IconButton>
						) : (
							<IconButton label="Revoke login" onClick={() => setConfirming('revoke')}>
								<BanIcon />
							</IconButton>
						)}
						{!builtIn && (
							<IconButton label="Delete agent" onClick={() => setConfirming('delete')}>
								<Trash2Icon />
							</IconButton>
						)}
					</>
				)
			}
		>
			<div className="flex flex-col gap-8">
				{error && <p className="text-sm text-destructive">{error}</p>}
				{mcpClients.length > 0 && (
					<Section title="MCP">
						<McpClients
							clients={mcpClients}
							mayChange={mayChange}
							onDisconnect={(clientId) => void apply(disconnectMcpClient(org, agent.id, clientId))}
						/>
					</Section>
				)}
				<Section
					title="Access"
					detail={
						agent.shared && !mayChange
							? 'changed by whoever made it and the owner'
							: changedDetail(agent)
					}
				>
					<AccessGrid
						agent={agent}
						connections={reachable}
						readOnly={!mayChange}
						setsDefaults={(connection) => manages(human, connection)}
						onChange={(connectionId, actions) =>
							apply(setAgentGrants(org, agent.id, connectionId, actions))
						}
						onMakeDefault={(connectionId, actionId, allowed) =>
							apply(makeDefault(org, agent.id, connectionId, actionId, allowed))
						}
					/>
				</Section>
				<Sharing
					orgName={activeOrg.name}
					shared={agent.shared}
					what="agent"
					rows={[
						{
							label: 'Reaches',
							value: agent.shared
								? `The connections shared with ${activeOrg.name}`
								: `The connections shared with ${activeOrg.name}, and your own`,
						},
						{label: 'Made by', value: createdBy},
					]}
					alone={!hasOtherPeople(activeOrg)}
					confirmDescription={`Everyone in ${activeOrg.name} sees ${agent.name} and can give its login to their own tools. It reaches only the connections shared with everyone from then on, so its settings on your own connections are dropped. Its tasks and activity so far become everyone's too, except what it did on your own connections, which stays yours. Whoever made it and the organization's owner change it. This can't be undone.`}
					onShare={() => apply(shareAgent(org, agent.id))}
				/>
				<Section
					title="Recent activity"
					detail={
						entries.length > RECENT ? (
							<Link
								to={`/${org}/activity?agent=${agent.id}`}
								className="underline-offset-4 hover:text-foreground hover:underline"
							>
								Go to all activity
							</Link>
						) : undefined
					}
				>
					<AuditList
						entries={entries.slice(0, RECENT)}
						agents={agents}
						connections={connections}
						tasks={tasks}
						showAgent={false}
					/>
				</Section>
			</div>
			{renaming && (
				<RenameDialog
					open
					title={`Rename ${agent.name}`}
					description="What this agent is called here, in the activity log and to the agent itself."
					initial={agent.name}
					allowEmpty={false}
					maxLength={AGENT_NAME_MAX}
					onClose={() => setRenaming(false)}
					onSave={async (name) => {
						const result = await renameAgent(org, agent.id, name);
						if (result.isErr()) {
							return describeApiError(result.error);
						}
						await revalidator.revalidate();
						return null;
					}}
				/>
			)}
			<ConfirmDialog
				open={confirming === 'revoke'}
				title={`Revoke ${agent.name}?`}
				description="The agent is signed out and cannot sign in again. Its access stays as it is, so restoring the login brings it back unchanged."
				confirmLabel="Revoke"
				destructive
				onClose={() => setConfirming(null)}
				onConfirm={() => void apply(setAgentRevoked(org, agent.id, true))}
			/>
			<ConfirmDialog
				open={confirming === 'delete'}
				title={`Delete ${agent.name}?`}
				description="The login and its access are gone for good. Its lines in the activity log stay."
				confirmLabel="Delete"
				destructive
				onClose={() => setConfirming(null)}
				onConfirm={async () => {
					const result = await deleteAgent(org, agent.id);
					if (result.isErr()) {
						setError(describeFetchError(result.error));
						return;
					}
					navigate(`/${org}/agents`);
				}}
			/>
		</AppShell>
	);
}

// The MCP clients, such as Claude, that signed in as this agent: every one for whoever manages the
// agent, with who signed each in; the person's own for anyone else. Each is signed out on its own,
// by whoever manages the agent or signed it in.
function McpClients({
	clients,
	mayChange,
	onDisconnect,
}: {
	clients: McpClient[];
	mayChange: boolean;
	onDisconnect: (clientId: string) => void;
}) {
	const connectedBy = (client: McpClient) => {
		if (client.mine) {
			return 'by you';
		}
		return `by ${client.connectedBy ?? 'a former member'}`;
	};
	return (
		<RowList>
			{clients.map((client) => (
				<li key={client.id} className="bleed flex h-10 items-center gap-3 text-sm">
					<span className="min-w-0 flex-1 truncate">{client.name}</span>
					<span className="shrink-0 text-muted-foreground">
						connected {formatDate(client.connectedAt)}
						{mayChange && ` ${connectedBy(client)}`}
					</span>
					{(mayChange || client.mine) && (
						<IconButton label={`Disconnect ${client.name}`} onClick={() => onDisconnect(client.id)}>
							<UnplugIcon />
						</IconButton>
					)}
				</li>
			))}
		</RowList>
	);
}

// Makes an agent's own setting the connection's default, for every agent without one of its own,
// and drops it, since it now matches the default.
async function makeDefault(
	org: string,
	agentId: string,
	connectionId: string,
	actionId: string,
	allowed: boolean,
): Promise<Result<void, FetchError>> {
	const defaults = await setConnectionDefaults(org, connectionId, {[actionId]: allowed});
	if (defaults.isErr()) {
		return defaults.map(() => undefined);
	}
	return (await setAgentGrants(org, agentId, connectionId, {[actionId]: null})).map(
		() => undefined,
	);
}

// "3 changed": how many actions the agent has a setting of its own for.
function changedDetail(agent: AgentLogin): string | undefined {
	if (agent.grants.length === 0) {
		return undefined;
	}
	return `${agent.grants.length} changed`;
}

type GridProps = {
	agent: AgentLogin;
	connections: Connection[];
	// Shown but not changed: a shared agent by a member who only sees it.
	readOnly: boolean;
	// Whether the person may change a connection's defaults, which making an agent's own setting
	// the default does: the connection is theirs to change too.
	setsDefaults: (connection: Connection) => boolean;
	onChange: (connectionId: string, actions: Record<string, boolean | null>) => Promise<void>;
	onMakeDefault: (connectionId: string, actionId: string, allowed: boolean) => Promise<void>;
};

// Every connection, the vault first, with a checkbox per action. Each starts folded to a line
// saying whether the agent follows its default or has changed something. A filter narrows them to
// the connections, actions and groups of actions (Calendar) it names, and Changed only keeps the actions the agent has a setting of its own for; either opens
// everything it keeps.
function AccessGrid({
	agent,
	connections,
	readOnly,
	setsDefaults,
	onChange,
	onMakeDefault,
}: GridProps) {
	const [query, setQuery] = useState('');
	const [changedOnly, setChangedOnly] = useState(false);
	const [opened, setOpened] = useState<Set<string>>(() => new Set());
	const filtering = query.trim() !== '' || changedOnly;
	const toggle = (connectionId: string) => {
		const next = new Set(opened);
		if (next.has(connectionId)) {
			next.delete(connectionId);
			setOpened(next);
			return;
		}
		next.add(connectionId);
		setOpened(next);
	};
	const matches = (text: string) => text.toLowerCase().includes(query.trim().toLowerCase());
	const groups = connections.flatMap((connection) => {
		const integration = integrationOf(connection);
		if (!integration) {
			return [];
		}

		const label = connectionLabel(connections, connection);
		const own = ownSettings(agent, connection.id);
		const named = [label, connection.account].some(matches);
		const actions = integration.actions
			.filter((action) => !changedOnly || own[action.id] !== undefined)
			.filter(
				(action) => named || [action.label, action.description, action.group ?? ''].some(matches),
			);
		if (actions.length === 0) {
			return [];
		}
		return [{connection, integration, label, own, actions}];
	});

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-center gap-4">
				<div className="relative max-w-xs flex-1">
					<SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="search"
						aria-label="Filter access"
						placeholder="Filter actions"
						className="h-8 pl-8"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</div>
				<label className="flex items-center gap-2 text-sm">
					<Checkbox checked={changedOnly} onCheckedChange={setChangedOnly} />
					Changed only
				</label>
			</div>
			{groups.length === 0 && (
				<RowList>
					<EmptyRows>
						{changedOnly && query.trim() === ''
							? 'This agent follows every default.'
							: 'Nothing matches the filter.'}
					</EmptyRows>
				</RowList>
			)}
			{/* One row per connection, as tall as the activity list's rows and as close together. */}
			<div className="flex flex-col">
				{groups.map(({connection, integration, label, own, actions}) => {
					const open = filtering || opened.has(connection.id);
					return (
						<div key={connection.id} className={cn('flex flex-col', open && 'pb-2')}>
							<button
								type="button"
								aria-expanded={open}
								onClick={() => toggle(connection.id)}
								className="bleed flex h-10 items-center gap-2 text-left text-sm hover:bg-muted/50"
							>
								<ChevronRightIcon
									className={cn(
										'size-4 shrink-0 text-muted-foreground transition-transform',
										open && 'rotate-90',
									)}
								/>
								<IntegrationLogo integration={integration} />
								<span className="min-w-0 truncate">{label}</span>
								<span className="ml-auto shrink-0 pl-3 text-muted-foreground">
									{Object.keys(own).length > 0 ? 'Changed' : 'Default'}
								</span>
							</button>
							{open && (
								<ConnectionAccess
									actions={actions}
									defaults={defaultActions(connection)}
									unavailable={connection.unavailable}
									signInNeeded={connection.signInNeeded}
									own={own}
									readOnly={readOnly}
									onChange={(changes) => onChange(connection.id, changes)}
									onMakeDefault={
										readOnly || !setsDefaults(connection)
											? undefined
											: (actionId, allowed) => onMakeDefault(connection.id, actionId, allowed)
									}
								/>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
