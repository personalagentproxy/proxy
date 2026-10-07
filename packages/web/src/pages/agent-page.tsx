import type {FetchError} from '@proxy/utils';
import {
	BanIcon,
	ChevronRightIcon,
	KeyRoundIcon,
	RotateCcwIcon,
	SearchIcon,
	Trash2Icon,
} from 'lucide-react';
import {useEffect, useState, type ReactNode} from 'react';
import {
	Link,
	useLoaderData,
	useLocation,
	useNavigate,
	useParams,
	useRevalidator,
} from 'react-router';
import type {Result} from 'ts-results-es';
import {
	deleteAgent,
	resetAgentPassword,
	setAgentGrants,
	setAgentRevoked,
} from '@/client/agents-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {BackButton} from '@/components/back-button';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {ConnectionAccess} from '@/components/connection-access';
import {CopyButton} from '@/components/copy-button';
import {IconButton} from '@/components/icon-button';
import {NotFound} from '@/components/not-found';
import {EmptyRows, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {Checkbox} from '@/components/ui/checkbox';
import {Input} from '@/components/ui/input';
import {
	actionsFor,
	connectionLabel,
	defaultActions,
	describeActions,
	integrationOf,
	ownSettings,
} from '@/lib/access';
import {cn} from '@/lib/utils';
import {formatDate} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {AgentLogin, Connection} from '@/lib/types';
import type {agentLoader} from '@/loaders';

const RECENT = 10;

type Confirming = 'reset' | 'revoke' | 'delete' | null;

// One agent login: what it signs in with, what it can reach, and what it did. Keyed by the
// agent, so a password shown for one is never carried over to the next.
export function AgentPage() {
	const {id = ''} = useParams();
	return <AgentDetail key={id} id={id} />;
}

// The password New agent hands over in the navigation's state, read once.
function passwordFromState(state: unknown): string | null {
	if (typeof state !== 'object' || state === null || !('password' in state)) {
		return null;
	}
	return typeof state.password === 'string' ? state.password : null;
}

function AgentDetail({id}: {id: string}) {
	const {agent, connections, agents, entries} = useLoaderData<typeof agentLoader>();
	const location = useLocation();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	// The password shows once: arriving from New agent, or right after a reset. It is kept only in
	// this page's memory, and cleared from the history entry so a reload doesn't show it again.
	const [password, setPassword] = useState(() => passwordFromState(location.state));
	const [confirming, setConfirming] = useState<Confirming>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (passwordFromState(location.state) !== null) {
			navigate(location.pathname, {replace: true, state: null});
		}
	}, [location, navigate]);
	if (!agent || agent.id !== id) {
		return <NotFound what="agent" back="/agents" backLabel="Back to agents" />;
	}

	const revoked = agent.revokedAt !== null;
	const apply = async <T,>(change: Promise<Result<T, FetchError>>): Promise<T | null> => {
		const result = await change;
		if (result.isErr()) {
			setError(describeFetchError(result.error));
			return null;
		}
		setError(null);
		await revalidator.revalidate();
		return result.value;
	};

	return (
		<AppShell
			title={
				<>
					<BackButton to="/agents" label="Back to agents" />
					<PageTitle
						detail={
							revoked
								? `revoked ${formatDate(agent.revokedAt ?? '')}`
								: `added ${formatDate(agent.createdAt)}`
						}
					>
						{agent.name}
					</PageTitle>
				</>
			}
			actions={
				<>
					<IconButton label="Reset password" onClick={() => setConfirming('reset')}>
						<KeyRoundIcon />
					</IconButton>
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
				<Section title="Sign-in" detail={revoked ? 'revoked, the agent cannot sign in' : undefined}>
					<Credentials agent={agent} password={password} />
				</Section>
				<Section title="Access" detail={changedDetail(agent)}>
					<AccessGrid
						agent={agent}
						connections={connections}
						onChange={(connectionId, actions) =>
							void apply(setAgentGrants(agent.id, connectionId, actions))
						}
					/>
				</Section>
				<Section
					title="Recent activity"
					action={
						entries.length > RECENT && (
							<Link
								to={`/activity?agent=${agent.id}`}
								className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
							>
								All activity
							</Link>
						)
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
				open={confirming === 'reset'}
				title="Reset the password?"
				description="The current password stops working at once. The new one is shown once, so have it ready to hand to the agent."
				confirmLabel="Reset password"
				onClose={() => setConfirming(null)}
				onConfirm={async () => {
					const reset = await apply(resetAgentPassword(agent.id));
					if (reset) {
						setPassword(reset.password);
					}
				}}
			/>
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

function Credentials({agent, password}: {agent: AgentLogin; password: string | null}) {
	const signInUrl = `${window.location.origin}/agent/login`;

	return (
		<div className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:mx-3">
			<CredentialLine label="Sign-in page" value={signInUrl}>
				<CopyButton value={signInUrl} label="Copy sign-in page" />
			</CredentialLine>
			<CredentialLine label="Username" value={agent.username} mono>
				<CopyButton value={agent.username} label="Copy username" />
			</CredentialLine>
			{password ? (
				<CredentialLine label="Password" value={password} mono>
					<CopyButton value={password} label="Copy password" />
				</CredentialLine>
			) : (
				<CredentialLine label="Password" value="Hidden. Reset it to get a new one." muted />
			)}
			{password && (
				<p className="text-sm text-muted-foreground">
					Copy the password now: it is not shown again once you leave this page.
				</p>
			)}
		</div>
	);
}

type LineProps = {
	label: string;
	value: string;
	mono?: boolean;
	muted?: boolean;
	children?: ReactNode;
};

function CredentialLine({label, value, mono = false, muted = false, children}: LineProps) {
	return (
		<div className="flex min-h-8 items-center gap-3 text-sm">
			<span className="w-24 shrink-0 text-muted-foreground">{label}</span>
			<span
				className={`min-w-0 flex-1 truncate ${mono ? 'font-mono text-xs' : ''} ${muted ? 'text-muted-foreground' : ''}`}
			>
				{value}
			</span>
			{children}
		</div>
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
	onChange: (connectionId: string, actions: Record<string, boolean | null>) => void;
};

// Every connection, Information first, with a checkbox per action. Each starts folded to a line
// saying what the agent can do there. A filter narrows them to the connections and actions it
// names, and Changed only keeps the actions the agent has a setting of its own for; either opens
// everything it keeps.
function AccessGrid({agent, connections, onChange}: GridProps) {
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
			{groups.map(({connection, integration, label, own, actions}) => {
				const open = filtering || opened.has(connection.id);
				const can = actionsFor(agent, connection);
				return (
					<div key={connection.id} className="flex flex-col gap-1">
						<button
							type="button"
							aria-expanded={open}
							onClick={() => toggle(connection.id)}
							className="flex h-8 items-center gap-2 text-left text-sm md:px-3"
						>
							<ChevronRightIcon
								className={cn(
									'size-4 shrink-0 text-muted-foreground transition-transform',
									open && 'rotate-90',
								)}
							/>
							<integration.icon className="size-4 shrink-0 text-muted-foreground" />
							<span className="shrink-0 font-medium">{label}</span>
							{Object.keys(own).length > 0 && (
								<span className="shrink-0 text-xs text-primary" title="Differs from the default">
									Changed
								</span>
							)}
							{!open && (
								<span className="ml-auto min-w-0 truncate pl-3 text-muted-foreground">
									{can.length > 0 ? describeActions(integration, can) : 'No access'}
								</span>
							)}
						</button>
						{open && (
							<ConnectionAccess
								actions={actions}
								defaults={defaultActions(connection)}
								own={own}
								onChange={(changes) => onChange(connection.id, changes)}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}
