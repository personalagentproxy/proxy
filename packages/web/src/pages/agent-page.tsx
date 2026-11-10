import type {AgentLogin, McpClient} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {AGENT_NAME_MAX, findAgentProvider} from '@proxy/utils/agent-providers';
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
import {useLoaderData, useNavigate, useParams, useRevalidator, useSearchParams} from 'react-router';
import {
	deleteAgent,
	disconnectMcpClient,
	renameAgent,
	setAgentGrants,
	setAgentRevoked,
	shareAgent,
} from '@/client/agents-client';
import {setConnectionDefaults} from '@/client/connections-client';
import {AccessGrid, AccessGridColumns} from '@/components/access-grid';
import {AgentSharing} from '@/components/agent-sharing';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {IconButton} from '@/components/icon-button';
import {NotFound} from '@/components/not-found';
import {PageTabs} from '@/components/page-tabs';
import {RecentActivity} from '@/components/recent-activity';
import {RenameDialog} from '@/components/rename-dialog';
import {EmptyRows, RowList} from '@/components/row-list';
import {Checkbox} from '@proxy/ui/components/checkbox';
import {Input} from '@proxy/ui/components/input';
import {useApply} from '@/hooks/use-apply';
import {useHuman} from '@/hooks/use-human';
import {connectionLabel, defaultActions, integrationOf, ownSettings, reaches} from '@/lib/access';
import {cn} from '@proxy/ui/lib/utils';
import {formatDate} from '@/lib/format';
import {chosenTab, type PageTab} from '@/lib/page-tabs';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {hasOtherPeople, manages} from '@/lib/orgs';
import type {agentLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

type Confirming = 'revoke' | 'delete' | null;

// One agent login, its parts as tabs, as a connection's page has them: what it may do with each
// connection it reaches, who has it, the MCP clients signed in as it, and what it did. Handing it
// its login is setup's (`/agents/:id/setup`), done once. A shared agent is changed by whoever made
// it and the organization's owner; everyone else sees it as it is. Keyed by the agent, so the
// access filter and what is folded out start over for each.
export function AgentPage() {
	const {id = ''} = useParams();
	return <AgentDetail key={id} id={id} />;
}

function AgentDetail({id}: {id: string}) {
	const org = useOrgSlug();
	const {agent, connections, agents, entries, tasks, mcpClients, members} =
		useLoaderData<typeof agentLoader>();
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [confirming, setConfirming] = useState<Confirming>(null);
	const [renaming, setRenaming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const apply = useApply(setError);
	const human = useHuman();
	if (!agent || agent.id !== id || !human) {
		return <NotFound what="agent" />;
	}

	const revoked = agent.revokedAt !== null;
	const activeOrg = human.org;
	const mayChange = manages(human, agent);
	// A shared agent reaches the connections shared with everyone alone.
	const reachable = connections.filter((connection) => reaches(agent, connection));
	const provider = findAgentProvider(agent.providerId);
	const company = provider?.company ?? agent.providerId;
	// A built-in agent has no login to hand out: it runs in Personal Agent Proxy itself.
	const builtIn = provider?.connects === 'built-in';
	// The page's parts, one shown at a time: the MCP clients only where any is signed in as it.
	const tabs: Array<PageTab<'permissions' | 'sharing' | 'mcp' | 'activity'>> = [
		{id: 'permissions', label: 'Permissions'},
		{id: 'sharing', label: 'Sharing'},
		...(mcpClients.length > 0
			? [{id: 'mcp' as const, label: 'MCP clients', count: mcpClients.length}]
			: []),
		{id: 'activity', label: 'Recent activity'},
	];
	const tab = chosenTab(tabs, searchParams);

	return (
		<AppShell
			title={
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
			<div className="flex flex-col gap-4">
				<PageTabs tabs={tabs} chosen={tab} label="Agent" />
				{tab === 'permissions' && (
					<div className="flex flex-col gap-2">
						<p className="text-sm text-muted-foreground">{permissionsIntro(agent, mayChange)}</p>
						<ConnectionsAccess
							agent={agent}
							connections={reachable}
							readOnly={!mayChange}
							setsDefaults={(connection) => manages(human, connection)}
							onChange={(connectionId, actions) =>
								apply(setAgentGrants(org, agent.id, connectionId, actions))
							}
							onChangeDefaults={(connectionId, actions) =>
								apply(setConnectionDefaults(org, connectionId, actions))
							}
						/>
					</div>
				)}
				{tab === 'sharing' && (
					<AgentSharing
						orgName={activeOrg.name}
						agent={agent}
						members={members}
						userId={human.user.id}
						mayChange={mayChange}
						alone={!hasOtherPeople(activeOrg)}
						onShare={() => apply(shareAgent(org, agent.id))}
					/>
				)}
				{tab === 'mcp' && (
					<McpClients
						clients={mcpClients}
						mayChange={mayChange}
						onDisconnect={(clientId) => void apply(disconnectMcpClient(org, agent.id, clientId))}
					/>
				)}
				{tab === 'activity' && (
					<RecentActivity
						entries={entries}
						agents={agents}
						connections={connections}
						tasks={tasks}
						allHref={`/${org}/activity?agent=${agent.id}`}
						of="agent"
					/>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
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

// What the Permissions tab says first: that the agent follows each connection's default unless it
// has a setting of its own, how many it has, and who changes them where the person doesn't.
function permissionsIntro(agent: AgentLogin, mayChange: boolean): string {
	const own = agent.grants.length;
	return [
		`${agent.name} gets what each connection’s Default says, unless a box of its own says otherwise.`,
		...(own > 0 ? [`It has ${own} of its own.`] : []),
		...(mayChange ? [] : ['Whoever made it and the organization’s owner change them.']),
	].join(' ');
}

type GridProps = {
	agent: AgentLogin;
	connections: Connection[];
	// Shown but not changed: a shared agent by a member who only sees it.
	readOnly: boolean;
	// Whether the person may change a connection's defaults, shown beside the agent's own: the
	// connection is theirs to change too.
	setsDefaults: (connection: Connection) => boolean;
	onChange: (connectionId: string, actions: Record<string, boolean | null>) => Promise<void>;
	onChangeDefaults: (connectionId: string, actions: Record<string, boolean>) => Promise<void>;
};

// Every connection the agent reaches, the vault first, each folded to its name, which opens to a
// grid of its actions under it (access-grid.tsx): the connection's default beside the agent's
// own, as the connection's page shows every agent's. A filter narrows them to the connections, actions and groups of actions
// (Calendar) it names, and Changed only keeps the actions the agent has a setting of its own for;
// either opens everything it keeps.
function ConnectionsAccess({
	agent,
	connections,
	readOnly,
	setsDefaults,
	onChange,
	onChangeDefaults,
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
					const grouped = actions.some((action) => action.group !== undefined);
					return (
						<div key={connection.id} className={cn('flex flex-col', open && 'pb-8')}>
							{/* The connection's name is the grid's heading, as tall open as folded: open, the
							    columns' names stand at its end, over the boxes, unless the integration's groups
							    each name them. */}
							<button
								type="button"
								aria-expanded={open}
								onClick={() => toggle(connection.id)}
								className="bleed flex h-10 items-center gap-2 rounded-md text-left text-sm hover:bg-muted/50"
							>
								<span className="flex min-w-0 flex-1 items-center gap-2">
									<ChevronRightIcon
										className={cn(
											'size-4 shrink-0 text-muted-foreground transition-transform',
											open && 'rotate-90',
										)}
									/>
									<IntegrationLogo integration={integration} />
									<span className="min-w-0 truncate">{label}</span>
								</span>
								{open && !grouped && <AccessGridColumns agents={[agent]} />}
							</button>
							{open && (
								<AccessGrid
									actions={actions}
									defaults={defaultActions(connection)}
									agents={[{agent, own, mayChange: !readOnly}]}
									unavailable={connection.unavailable}
									signInNeeded={connection.signInNeeded}
									mayChangeDefaults={setsDefaults(connection)}
									onChangeDefaults={(changes) => onChangeDefaults(connection.id, changes)}
									onChangeAgent={(_agentId, actionId, allowed) =>
										onChange(connection.id, {[actionId]: allowed})
									}
									unlinked
									headed
								/>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
