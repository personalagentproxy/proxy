import type {Access} from '@proxy/integrations';
import {findAgentProvider} from '@proxy/agent-providers';
import type {FetchError} from '@proxy/utils';
import {BanIcon, KeyRoundIcon, RotateCcwIcon, Trash2Icon} from 'lucide-react';
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
	setAgentGrant,
	setAgentRevoked,
} from '@/client/agents-client';
import {AccessSelect} from '@/components/access-select';
import {AgentFavicon} from '@/components/agent-favicon';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {BackButton} from '@/components/back-button';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {CopyButton} from '@/components/copy-button';
import {IconButton} from '@/components/icon-button';
import {IntegrationLogo} from '@/components/integration-logo';
import {NotFound} from '@/components/not-found';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {connectionLabel, defaultAccess, integrationOf, ownAccess} from '@/lib/access';
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
	const provider = agent.providerId ? findAgentProvider(agent.providerId) : undefined;
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
								? `${provider?.company ?? 'Legacy'} · revoked ${formatDate(agent.revokedAt ?? '')}`
								: `${provider?.company ?? 'Legacy'} · added ${formatDate(agent.createdAt)}`
						}
					>
						<span className="flex items-center gap-2">
							<AgentFavicon provider={provider} />
							{provider?.name ?? agent.name}
						</span>
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
				<Section title="Access">
					<AccessGrid
						agent={agent}
						connections={connections}
						onChange={(connectionId, collectionId, access) =>
							void apply(setAgentGrant(agent.id, connectionId, collectionId, access))
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

type GridProps = {
	agent: AgentLogin;
	connections: Connection[];
	onChange: (connectionId: string, collectionId: string, access: Access | null) => void;
};

// One select per collection of every connection, Information first. Each starts on the
// connection's default; a setting of the agent's own is marked, and Default returns it there.
function AccessGrid({agent, connections, onChange}: GridProps) {
	return (
		<div className="flex flex-col gap-6">
			{connections.map((connection) => {
				const integration = integrationOf(connection);
				if (!integration) {
					return null;
				}
				return (
					<div key={connection.id} className="flex flex-col gap-1">
						<div className="flex items-center gap-2 text-sm md:px-3">
							<IntegrationLogo integration={integration} />
							<Link
								to={`/connections/${connection.id}`}
								className="font-medium underline-offset-4 hover:underline"
							>
								{connectionLabel(connections, connection)}
							</Link>
							<span className="truncate text-muted-foreground">{connection.account}</span>
						</div>
						<RowList>
							{integration.collections.map((collection) => (
								<li
									key={collection.id}
									className="flex h-10 items-center gap-3 px-4 text-sm md:px-3"
								>
									<span className="min-w-0 flex-1 truncate">{collection.name}</span>
									<AccessSelect
										value={ownAccess(agent, connection.id, collection.id)}
										collection={collection}
										connectionDefault={defaultAccess(connection, collection.id)}
										onChange={(next) => onChange(connection.id, collection.id, next)}
									/>
								</li>
							))}
						</RowList>
					</div>
				);
			})}
		</div>
	);
}
