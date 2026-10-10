import {findAgentProvider} from '@proxy/integrations';
import type {FetchError} from '@proxy/utils';
import {
	BanIcon,
	ChevronRightIcon,
	KeyRoundIcon,
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
	setAgentGrants,
	setAgentRevoked,
	type McpClient,
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
import {EmptyRows, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Checkbox} from '@proxy/ui/components/checkbox';
import {Input} from '@proxy/ui/components/input';
import {connectionLabel, defaultActions, integrationOf, ownSettings} from '@/lib/access';
import {cn} from '@proxy/ui/lib/utils';
import {formatDate} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {AgentLogin, Connection} from '@/lib/types';
import type {agentLoader} from '@/loaders';

const RECENT = 10;

type Confirming = 'revoke' | 'delete' | null;

// One agent login: what it can reach, and what it did. Handing it its login is setup's
// (`/agents/:id/setup`), done once. Keyed by the agent, so the access filter and what is folded
// out start over for each.
export function AgentPage() {
	const {id = ''} = useParams();
	return <AgentDetail key={id} id={id} />;
}

function AgentDetail({id}: {id: string}) {
	const {agent, connections, agents, entries, mcpClients} = useLoaderData<typeof agentLoader>();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [confirming, setConfirming] = useState<Confirming>(null);
	const [error, setError] = useState<string | null>(null);
	if (!agent || agent.id !== id) {
		return <NotFound what="agent" back="/agents" backLabel="Back to agents" />;
	}

	const revoked = agent.revokedAt !== null;
	const company = findAgentProvider(agent.providerId)?.company ?? agent.providerId;
	const apply = async <T,>(change: Promise<Result<T, FetchError>>) => {
		const result = await change;
		if (result.isErr()) {
			setError(describeFetchError(result.error));
			return;
		}
		setError(null);
		await revalidator.revalidate();
	};

	return (
		<AppShell
			title={
				<>
					<BackButton to="/agents" label="Back to agents" />
					<PageTitle
						detail={
							revoked
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
				<>
					{!revoked && (
						<IconButton label="Set up again" to={`/agents/${agent.id}/setup`}>
							<KeyRoundIcon />
						</IconButton>
					)}
					{revoked ? (
						<IconButton
							label="Restore login"
							onClick={() => void apply(setAgentRevoked(agent.id, false))}
						>
							<RotateCcwIcon />
						</IconButton>
					) : (
						<IconButton label="Revoke login" onClick={() => setConfirming('revoke')}>
							<BanIcon />
						</IconButton>
					)}
					<IconButton label="Delete agent" onClick={() => setConfirming('delete')}>
						<Trash2Icon />
					</IconButton>
				</>
			}
		>
			<div className="flex flex-col gap-8">
				{error && <p className="text-sm text-destructive md:px-3">{error}</p>}
				{mcpClients.length > 0 && (
					<Section title="MCP">
						<McpClients
							clients={mcpClients}
							onDisconnect={(clientId) => void apply(disconnectMcpClient(agent.id, clientId))}
						/>
					</Section>
				)}
				<Section title="Access" detail={changedDetail(agent)}>
					<AccessGrid
						agent={agent}
						connections={connections}
						onChange={(connectionId, actions) =>
							void apply(setAgentGrants(agent.id, connectionId, actions))
						}
						onMakeDefault={(connectionId, actionId, allowed) =>
							void apply(makeDefault(agent.id, connectionId, actionId, allowed))
						}
					/>
				</Section>
				<Section
					title="Recent activity"
					detail={
						entries.length > RECENT ? (
							<Link
								to={`/activity?agent=${agent.id}`}
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
						showAgent={false}
					/>
				</Section>
			</div>
			<ConfirmDialog
				open={confirming === 'revoke'}
				title={`Revoke ${agent.name}?`}
				description="The agent is signed out and cannot sign in again. Its access stays as it is, so restoring the login brings it back unchanged."
				confirmLabel="Revoke"
				destructive
				onClose={() => setConfirming(null)}
				onConfirm={() => void apply(setAgentRevoked(agent.id, true))}
			/>
			<ConfirmDialog
				open={confirming === 'delete'}
				title={`Delete ${agent.name}?`}
				description="The login and its access are gone for good. Its lines in the activity log stay."
				confirmLabel="Delete"
				destructive
				onClose={() => setConfirming(null)}
				onConfirm={async () => {
					const result = await deleteAgent(agent.id);
					if (result.isErr()) {
						setError(describeFetchError(result.error));
						return;
					}
					navigate('/agents');
				}}
			/>
		</AppShell>
	);
}

// The MCP clients, such as Claude, that signed in as this agent, each to be signed out on its own.
function McpClients({
	clients,
	onDisconnect,
}: {
	clients: McpClient[];
	onDisconnect: (clientId: string) => void;
}) {
	return (
		<RowList>
			{clients.map((client) => (
				<li key={client.id} className="flex h-10 items-center gap-3 px-4 text-sm md:px-3">
					<span className="min-w-0 flex-1 truncate">{client.name}</span>
					<span className="shrink-0 text-muted-foreground">
						connected {formatDate(client.connectedAt)}
					</span>
					<IconButton label={`Disconnect ${client.name}`} onClick={() => onDisconnect(client.id)}>
						<UnplugIcon />
					</IconButton>
				</li>
			))}
		</RowList>
	);
}

// Makes an agent's own setting the connection's default, for every agent without one of its own,
// and drops it, since it now matches the default.
async function makeDefault(
	agentId: string,
	connectionId: string,
	actionId: string,
	allowed: boolean,
): Promise<Result<void, FetchError>> {
	const defaults = await setConnectionDefaults(connectionId, {[actionId]: allowed});
	if (defaults.isErr()) {
		return defaults.map(() => undefined);
	}
	return (await setAgentGrants(agentId, connectionId, {[actionId]: null})).map(() => undefined);
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
	onChange: (connectionId: string, actions: Record<string, boolean | null>) => void;
	onMakeDefault: (connectionId: string, actionId: string, allowed: boolean) => void;
};

// Every connection, Information first, with a checkbox per action. Each starts folded to a line
// saying whether the agent follows its default or has changed something. A filter narrows them to the connections and actions it
// names, and Changed only keeps the actions the agent has a setting of its own for; either opens
// everything it keeps.
function AccessGrid({agent, connections, onChange, onMakeDefault}: GridProps) {
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
			.filter((action) => named || matches(action.label) || matches(action.description));
		if (actions.length === 0) {
			return [];
		}
		return [{connection, integration, label, own, actions}];
	});

	return (
		<div className="flex flex-col gap-6">
			<div className="flex items-center gap-4 md:px-3">
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
						<div key={connection.id} className={cn('flex flex-col', open && 'mb-2')}>
							<button
								type="button"
								aria-expanded={open}
								onClick={() => toggle(connection.id)}
								className="-mx-4 flex h-10 items-center gap-2 px-4 text-left text-sm hover:bg-muted/50 md:mx-0 md:px-3"
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
									own={own}
									onChange={(changes) => onChange(connection.id, changes)}
									onMakeDefault={(actionId, allowed) =>
										onMakeDefault(connection.id, actionId, allowed)
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
