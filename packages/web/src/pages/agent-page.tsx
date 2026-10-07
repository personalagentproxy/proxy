import {BanIcon, KeyRoundIcon, RotateCcwIcon, Trash2Icon} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {Link, useLocation, useNavigate, useParams} from 'react-router';
import {AgentFavicon} from '@/components/agent-favicon';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {BackButton} from '@/components/back-button';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {IntegrationLogo} from '@/components/integration-logo';
import {CopyButton} from '@/components/copy-button';
import {IconButton} from '@/components/icon-button';
import {useStore} from '@/components/mock-store';
import {NotFound} from '@/components/not-found';
import {RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select';
import {ACCESS_LABELS, ACCESS_LEVELS, accessFor, integrationOf} from '@/lib/access';
import {agentProvider} from '@/lib/agent-providers';
import {formatDate} from '@/lib/format';
import type {Access, AgentLogin} from '@/lib/types';

const RECENT = 10;

type Confirming = 'reset' | 'revoke' | 'delete' | null;

// One agent login: what it signs in with, what it can reach, and what it did. Keyed by the
// agent, so a password shown for one is never carried over to the next.
export function AgentPage() {
	const {id = ''} = useParams();
	return <AgentDetail key={id} id={id} />;
}

function AgentDetail({id}: {id: string}) {
	const location = useLocation();
	const navigate = useNavigate();
	const {state, resetPassword, setRevoked, deleteAgent} = useStore();
	// The password shows once: arriving from New agent, or right after a reset.
	const [reveal, setReveal] = useState(
		(location.state as {reveal?: boolean} | null)?.reveal === true,
	);
	const [confirming, setConfirming] = useState<Confirming>(null);
	const agent = state.agents.find((candidate) => candidate.id === id);
	if (!agent) {
		return <NotFound what="agent" back="/agents" backLabel="Back to agents" />;
	}

	const revoked = agent.revokedAt !== null;
	const provider = agentProvider(agent.providerId);
	const activity = state.audit.filter((entry) => entry.agentId === agent.id);

	return (
		<AppShell
			title={
				<>
					<BackButton to="/agents" label="Back to agents" />
					<PageTitle
						detail={
							revoked
								? `${provider.company} · revoked ${formatDate(agent.revokedAt ?? '')}`
								: `${provider.company} · added ${formatDate(agent.createdAt)}`
						}
					>
						<span className="flex items-center gap-2">
							<AgentFavicon provider={provider} className="size-4" />
							{provider.name}
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
						<IconButton label="Restore login" onClick={() => setRevoked(agent.id, false)}>
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
				<Section title="Sign-in" detail={revoked ? 'revoked, the agent cannot sign in' : undefined}>
					<Credentials agent={agent} reveal={reveal} />
				</Section>
				<Section title="Access">
					<AccessGrid agent={agent} />
				</Section>
				<Section
					title="Recent activity"
					action={
						activity.length > RECENT && (
							<Link
								to={`/activity?agent=${agent.id}`}
								className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
							>
								All activity
							</Link>
						)
					}
				>
					<AuditList entries={activity.slice(0, RECENT)} showAgent={false} />
				</Section>
			</div>
			<ConfirmDialog
				open={confirming === 'reset'}
				title="Reset the password?"
				description="The current password stops working at once. The new one is shown once, so have it ready to hand to the agent."
				confirmLabel="Reset password"
				onClose={() => setConfirming(null)}
				onConfirm={() => {
					resetPassword(agent.id);
					setReveal(true);
				}}
			/>
			<ConfirmDialog
				open={confirming === 'revoke'}
				title={`Revoke ${provider.name}?`}
				description="The agent is signed out and cannot sign in again. Its access stays as it is, so restoring the login brings it back unchanged."
				confirmLabel="Revoke"
				destructive
				onClose={() => setConfirming(null)}
				onConfirm={() => setRevoked(agent.id, true)}
			/>
			<ConfirmDialog
				open={confirming === 'delete'}
				title={`Delete ${provider.name}?`}
				description="The login and its access are gone for good. Its lines in the activity log stay."
				confirmLabel="Delete"
				destructive
				onClose={() => setConfirming(null)}
				onConfirm={() => {
					deleteAgent(agent.id);
					navigate('/agents');
				}}
			/>
		</AppShell>
	);
}

function Credentials({agent, reveal}: {agent: AgentLogin; reveal: boolean}) {
	const signInUrl = `${window.location.origin}/agent/login`;

	return (
		<div className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:mx-3">
			<CredentialLine label="Sign-in page" value={signInUrl}>
				<CopyButton value={signInUrl} label="Copy sign-in page" />
			</CredentialLine>
			<CredentialLine label="Username" value={agent.username} mono>
				<CopyButton value={agent.username} label="Copy username" />
			</CredentialLine>
			{reveal ? (
				<CredentialLine label="Password" value={agent.password} mono>
					<CopyButton value={agent.password} label="Copy password" />
				</CredentialLine>
			) : (
				<CredentialLine label="Password" value="Hidden. Reset it to get a new one." muted />
			)}
			{reveal && (
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

const LEVEL_ITEMS = ACCESS_LEVELS.map((level) => ({value: level, label: ACCESS_LABELS[level]}));

function isAccess(value: string): value is Access {
	return ACCESS_LEVELS.some((level) => level === value);
}

// One select per collection of every connection, Information first. A change applies at once.
function AccessGrid({agent}: {agent: AgentLogin}) {
	const {state, setAccess} = useStore();

	return (
		<div className="flex flex-col gap-6">
			{state.connections.map((connection) => {
				const integration = integrationOf(connection);
				return (
					<div key={connection.id} className="flex flex-col gap-1">
						<div className="flex items-center gap-2 text-sm md:px-3">
							<IntegrationLogo integration={integration} />
							<span className="font-medium">{integration.name}</span>
							<span className="truncate text-muted-foreground">{connection.account}</span>
						</div>
						<RowList>
							{integration.collections.map((collection) => {
								const access = accessFor(agent, connection.id, collection.id);
								return (
									<li
										key={collection.id}
										className="flex h-10 items-center gap-3 px-4 text-sm md:px-3"
									>
										<span className="min-w-0 flex-1 truncate">{collection.name}</span>
										<Select
											value={access}
											items={LEVEL_ITEMS}
											onValueChange={(next) => {
												if (next !== null && isAccess(next)) {
													setAccess(agent.id, connection.id, collection.id, next);
												}
											}}
										>
											<SelectTrigger
												size="sm"
												aria-label={`${collection.name} access`}
												className={`w-32 ${access === 'none' ? 'text-muted-foreground' : ''}`}
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent align="end" alignItemWithTrigger={false}>
												{LEVEL_ITEMS.map((item) => (
													<SelectItem key={item.value} value={item.value}>
														{item.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</li>
								);
							})}
						</RowList>
					</div>
				);
			})}
		</div>
	);
}
