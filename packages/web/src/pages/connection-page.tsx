import {CircleCheckIcon, UnplugIcon} from 'lucide-react';
import {useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator, useSearchParams} from 'react-router';
import {deleteConnection, setConnectionDefaults} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {BackButton} from '@/components/back-button';
import {ConnectionAccess} from '@/components/connection-access';
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
	// Set by whatever made the connection: the email dialog, or the api back from a service's sign-in.
	const [searchParams] = useSearchParams();
	const added = searchParams.has('added');
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
				{added && (
					<p className="flex items-center gap-2 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
						<CircleCheckIcon className="size-4 shrink-0" />
						Connection added successfully
					</p>
				)}
				<Section title="Permissions">
					<ConnectionAccess
						actions={integration.actions}
						defaults={defaultActions(connection)}
						differing={differingAgents(agents, connection.id)}
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
