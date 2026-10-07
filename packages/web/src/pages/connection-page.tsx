import {UnplugIcon} from 'lucide-react';
import {useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator} from 'react-router';
import {deleteConnection, setConnectionDefault} from '@/client/connections-client';
import {AccessSelect} from '@/components/access-select';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {BackButton} from '@/components/back-button';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {IconButton} from '@/components/icon-button';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {NotFound} from '@/components/not-found';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {accessFor, accessLabel, agentsWithAccess, defaultAccess, integrationOf} from '@/lib/access';
import {formatDate} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import type {connectionLoader} from '@/loaders';

const RECENT = 10;

export function ConnectionPage() {
	const {connection, connections, agents, entries} = useLoaderData<typeof connectionLoader>();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const [disconnecting, setDisconnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const integration = connection && integrationOf(connection);
	if (!connection || !integration) {
		return <NotFound what="connection" back="/connections" backLabel="Back to connections" />;
	}

	const withAccess = agentsWithAccess(agents, connection);

	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections" label="Back to connections" />
					<PageTitle detail={connection.account}>
						<span className="flex items-center gap-2">
							<IntegrationLogo integration={integration} />
							{integration.name}
						</span>
					</PageTitle>
				</>
			}
			actions={
				!integration.builtIn && (
					<IconButton label="Disconnect" onClick={() => setDisconnecting(true)}>
						<UnplugIcon />
					</IconButton>
				)
			}
		>
			<div className="flex flex-col gap-8">
				<Section title="Default access" detail={`connected ${formatDate(connection.connectedAt)}`}>
					<p className="mb-2 text-sm text-muted-foreground md:px-3">
						What every agent gets here, unless its own page says otherwise.
					</p>
					<RowList>
						{integration.collections.map((collection) => (
							<li key={collection.id} className="flex h-10 items-center gap-3 px-4 text-sm md:px-3">
								<span className="min-w-0 flex-1 truncate">{collection.name}</span>
								<AccessSelect
									value={defaultAccess(connection, collection.id)}
									collection={collection}
									onChange={async (next) => {
										const result = await setConnectionDefault(
											connection.id,
											collection.id,
											next ?? 'none',
										);
										setError(result.isErr() ? describeFetchError(result.error) : null);
										await revalidator.revalidate();
									}}
								/>
							</li>
						))}
					</RowList>
					{error && <p className="mt-2 text-sm text-destructive md:px-3">{error}</p>}
				</Section>
				<Section title="Agents with access">
					<RowList>
						{withAccess.length === 0 && <EmptyRows>No agent can reach this connection.</EmptyRows>}
						{withAccess.map((agent) => (
							<Row
								key={agent.id}
								to={`/agents/${agent.id}`}
								icon={<AgentLogo providerId={agent.providerId} />}
								title={agent.name}
								cells={
									<span className="hidden min-w-0 shrink truncate text-right text-muted-foreground md:block">
										{integration.collections
											.filter((collection) => accessFor(agent, connection, collection) !== 'none')
											.map(
												(collection) =>
													`${collection.name}: ${accessLabel(collection, accessFor(agent, connection, collection))}`,
											)
											.join(', ')}
									</span>
								}
							/>
						))}
					</RowList>
				</Section>
				<Section
					title="Recent activity"
					action={
						entries.length > RECENT && (
							<Link
								to={`/activity?connection=${connection.id}`}
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
						showConnection={false}
					/>
				</Section>
			</div>
			<ConfirmDialog
				open={disconnecting}
				title={`Disconnect ${integration.name}?`}
				description={`Agents lose access to ${connection.account} at once, and the access you gave them here is forgotten. You can connect it again later.`}
				confirmLabel="Disconnect"
				destructive
				onClose={() => setDisconnecting(false)}
				onConfirm={async () => {
					const result = await deleteConnection(connection.id);
					if (result.isErr()) {
						setError(describeFetchError(result.error));
						return;
					}
					navigate('/connections');
				}}
			/>
		</AppShell>
	);
}
