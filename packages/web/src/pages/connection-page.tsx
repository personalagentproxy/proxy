import {UnplugIcon} from 'lucide-react';
import {useState} from 'react';
import {Link, useNavigate, useParams} from 'react-router';
import {AgentFavicon} from '@/components/agent-favicon';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {BackButton} from '@/components/back-button';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {IconButton} from '@/components/icon-button';
import {useStore} from '@/components/mock-store';
import {NotFound} from '@/components/not-found';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {ACCESS_LABELS, accessFor, agentsWithAccess, integrationOf, recordsOf} from '@/lib/access';
import {agentProvider} from '@/lib/agent-providers';
import {formatDate} from '@/lib/format';

const RECENT = 10;

export function ConnectionPage() {
	const {id = ''} = useParams();
	const navigate = useNavigate();
	const {state, disconnect} = useStore();
	const [disconnecting, setDisconnecting] = useState(false);
	const connection = state.connections.find((candidate) => candidate.id === id);
	if (!connection) {
		return <NotFound what="connection" back="/connections" backLabel="Back to connections" />;
	}

	const integration = integrationOf(connection);
	const agents = agentsWithAccess(state, connection.id);
	const activity = state.audit.filter((entry) => entry.connectionId === connection.id);

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections" label="Back to connections" />
					<PageTitle detail={connection.account}>{integration.name}</PageTitle>
				</>
			}
			actions={
				<IconButton label="Disconnect" onClick={() => setDisconnecting(true)}>
					<UnplugIcon />
				</IconButton>
			}
		>
			<div className="flex flex-col gap-8">
				<Section title="What it shares" detail={`connected ${formatDate(connection.connectedAt)}`}>
					<RowList>
						{integration.collections.map((collection) => (
							<li key={collection.id} className="flex h-10 items-center gap-3 px-4 text-sm md:px-3">
								<span className="min-w-0 flex-1 truncate">{collection.name}</span>
								<span className="text-muted-foreground tabular-nums">
									{recordsOf(state, connection.id, collection.id).length}
								</span>
							</li>
						))}
					</RowList>
				</Section>
				<Section title="Agents with access">
					<RowList>
						{agents.length === 0 && (
							<EmptyRows>
								No agent can reach this connection. Give access from an agent's page.
							</EmptyRows>
						)}
						{agents.map((agent) => {
							const provider = agentProvider(agent.providerId);
							return (
								<Row
									key={agent.id}
									to={`/agents/${agent.id}`}
									icon={<AgentFavicon provider={provider} className="size-4" />}
									title={provider.name}
									cells={
										<span className="hidden min-w-0 shrink truncate text-right text-muted-foreground md:block">
											{integration.collections
												.filter(
													(collection) => accessFor(agent, connection.id, collection.id) !== 'none',
												)
												.map(
													(collection) =>
														`${collection.name}: ${ACCESS_LABELS[accessFor(agent, connection.id, collection.id)]}`,
												)
												.join(', ')}
										</span>
									}
								/>
							);
						})}
					</RowList>
				</Section>
				<Section
					title="Recent activity"
					action={
						activity.length > RECENT && (
							<Link
								to={`/activity?connection=${connection.id}`}
								className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
							>
								All activity
							</Link>
						)
					}
				>
					<AuditList entries={activity.slice(0, RECENT)} showConnection={false} />
				</Section>
			</div>
			<ConfirmDialog
				open={disconnecting}
				title={`Disconnect ${integration.name}?`}
				description={`Agents lose access to ${connection.account} at once, and the access you gave them here is forgotten. You can connect it again later.`}
				confirmLabel="Disconnect"
				destructive
				onClose={() => setDisconnecting(false)}
				onConfirm={() => {
					disconnect(connection.id);
					navigate('/connections');
				}}
			/>
		</AppShell>
	);
}
