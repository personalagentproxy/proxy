import {CircleCheckIcon, ListRestartIcon, RefreshCwIcon, UnplugIcon} from 'lucide-react';
import type {FetchError} from '@proxy/utils';
import {useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator, useSearchParams} from 'react-router';
import {
	deleteConnection,
	refreshMcpTools,
	setConnectionDefaults,
} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {BackButton} from '@/components/back-button';
import {ConnectionAccess} from '@/components/connection-access';
import {useAccessSaves} from '@/hooks/use-access-saves';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {IconButton} from '@/components/icon-button';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {NotFound} from '@/components/not-found';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {
	actionsFor,
	agentsWithAccess,
	defaultActions,
	defaultsOnOrOff,
	integrationOf,
	ownSettings,
	describeActions,
} from '@/lib/access';
import {describeFetchError} from '@/lib/loader-utils';
import type {AgentLogin} from '@/lib/types';
import type {connectionLoader} from '@/loaders';

const RECENT = 10;

export function ConnectionPage() {
	const {connection, connections, agents, entries} = useLoaderData<typeof connectionLoader>();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	const savesFor = useAccessSaves();
	// Set by whatever made the connection: the email dialog, or the api back from a service's sign-in.
	const [searchParams] = useSearchParams();
	const added = searchParams.has('added');
	const [disconnecting, setDisconnecting] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
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
					<PageTitle
						detail={
							connection.name === null
								? connection.account
								: `${integration.name} · ${connection.account}`
						}
					>
						<span className="flex items-center gap-2">
							<IntegrationLogo integration={integration} />
							{connection.name ?? integration.name}
						</span>
					</PageTitle>
				</>
			}
			actions={
				<>
					{integration.custom && (
						<IconButton
							label={
								refreshing
									? 'Asking the server for its tools'
									: 'Ask the server for its tools again'
							}
							disabled={refreshing}
							onClick={async () => {
								setRefreshing(true);
								const result = await refreshMcpTools(connection.id);
								setRefreshing(false);
								setError(result.isErr() ? describeRefreshError(result.error) : null);
								await revalidator.revalidate();
							}}
						>
							<ListRestartIcon className={refreshing ? 'motion-safe:animate-spin' : undefined} />
						</IconButton>
					)}
					{!integration.builtIn && (
						<IconButton label="Disconnect" onClick={() => setDisconnecting(true)}>
							<UnplugIcon />
						</IconButton>
					)}
				</>
			}
		>
			<div className="flex flex-col gap-8">
				{added && (
					<p className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
						<CircleCheckIcon className="size-4 shrink-0" />
						Connection added successfully
					</p>
				)}
				<Section
					title="Permissions"
					detail={
						integration.custom
							? 'The server’s tools, as it last listed them, each allowed on its own'
							: undefined
					}
				>
					{integration.custom && integration.actions.length === 0 && (
						<p className="text-sm text-muted-foreground md:px-3">The server lists no tools.</p>
					)}
					<ConnectionAccess
						actions={integration.actions}
						defaults={defaultActions(connection)}
						differing={differingAgents(agents, connection.id)}
						saves={savesFor(connection.id)}
						onChange={async (actions) => {
							const result = await setConnectionDefaults(connection.id, defaultsOnOrOff(actions));
							setError(result.isErr() ? describeFetchError(result.error) : null);
							await revalidator.revalidate();
						}}
					/>
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
										{describeActions(integration, actionsFor(agent, connection))}
									</span>
								}
							/>
						))}
					</RowList>
				</Section>
				<Section
					title="Recent activity"
					titleAction={
						<IconButton
							label={revalidator.state === 'loading' ? 'Refreshing activity' : 'Refresh activity'}
							size="xs"
							disabled={revalidator.state === 'loading'}
							onClick={() => void revalidator.revalidate()}
						>
							<RefreshCwIcon
								className={revalidator.state === 'loading' ? 'motion-safe:animate-spin' : undefined}
							/>
						</IconButton>
					}
					detail={
						entries.length > RECENT ? (
							<Link
								to={`/activity?connection=${connection.id}`}
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

// What asking a custom MCP server for its tools again says when it fails.
function describeRefreshError(error: FetchError): string {
	if (error.kind === 'http' && error.status === 422) {
		return 'The server turned the sign-in down. Disconnect it and connect it again.';
	}
	if (error.kind === 'http' && error.status === 502) {
		return 'The server could not be reached. Try again in a moment.';
	}
	return describeFetchError(error);
}

// How many agents, revoked ones left out, have a setting of their own for each action.
function differingAgents(
	agents: AgentLogin[],
	connectionId: string,
): Partial<Record<string, number>> {
	const counts: Partial<Record<string, number>> = {};
	for (const agent of agents) {
		if (agent.revokedAt !== null) {
			continue;
		}
		for (const actionId of Object.keys(ownSettings(agent, connectionId))) {
			counts[actionId] = (counts[actionId] ?? 0) + 1;
		}
	}
	return counts;
}
