import {ListRestartIcon, RefreshCwIcon, UnplugIcon} from 'lucide-react';
import type {FetchError} from '@proxy/utils';
import {useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator, useSearchParams} from 'react-router';
import {
	deleteConnection,
	refreshMcpTools,
	setConnectionDefaults,
	shareConnection,
} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {SignInToBankAgain} from '@/components/connect-bank-form';
import {BackButton} from '@/components/back-button';
import {ConnectWithKeyDialog} from '@/components/connect-with-key-dialog';
import {ConnectionAccess, SignInAgain} from '@/components/connection-access';
import {Sharing} from '@/components/sharing';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {IconButton} from '@/components/icon-button';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {NotFound} from '@/components/not-found';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {Section} from '@/components/section';
import {SuccessLine} from '@/components/success-line';
import {
	actionsFor,
	agentsWithAccess,
	defaultActions,
	defaultsOnOrOff,
	integrationOf,
	ownSettings,
	describeActions,
} from '@/lib/access';
import {useHuman} from '@/hooks/use-human';
import {signInPath} from '@/lib/integrations';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {actsAs, connectedBy, hasOtherPeople, manages} from '@/lib/orgs';
import type {AgentLogin} from '@/lib/types';
import type {connectionLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

const RECENT = 10;

export function ConnectionPage() {
	const org = useOrgSlug();
	const {connection, connections, agents, entries, tasks} =
		useLoaderData<typeof connectionLoader>();
	const navigate = useNavigate();
	const revalidator = useRevalidator();
	// Set by whatever made the connection: the email dialog, or the api back from a service's sign-in.
	const [searchParams] = useSearchParams();
	const added = searchParams.has('added');
	const [disconnecting, setDisconnecting] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [replacingKey, setReplacingKey] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const human = useHuman();
	const integration = connection && integrationOf(connection);
	if (!connection || !integration || !human) {
		return (
			<NotFound what="connection" back={`/${org}/connections`} backLabel="Back to connections" />
		);
	}

	const withAccess = agentsWithAccess(agents, connection);
	const activeOrg = human.org;
	// One's own connection is one's to change; a shared one is whoever connected it's and the
	// organization's owner's. Everyone else in the organization uses it as it is.
	const mayChange = manages(human, connection);
	const actingAs = actsAs(connection, human);
	// Why the connection can be signed in to again from here: its sign-in left actions out, it has
	// none, or its integration says nothing of who signed in, so only this page renews it.
	const renewReason = connection.signInNeeded
		? 'needed'
		: connection.unavailable.length > 0
			? 'unavailable'
			: integration.anonymous
				? 'renew'
				: null;
	const renew =
		renewReason === null || !mayChange
			? null
			: signInPath(org, connection.integrationId, {
					account: connection.account,
					connection: connection.id,
				});

	return (
		<AppShell
			title={
				<>
					<BackButton to={`/${org}/connections`} label="Back to connections" />
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
					{integration.custom && mayChange && (
						<IconButton
							label={
								refreshing
									? 'Asking the server for its tools'
									: 'Ask the server for its tools again'
							}
							disabled={refreshing}
							onClick={async () => {
								setRefreshing(true);
								const result = await refreshMcpTools(org, connection.id);
								setRefreshing(false);
								setError(result.isErr() ? describeRefreshError(result.error) : null);
								await revalidator.revalidate();
							}}
						>
							<ListRestartIcon className={refreshing ? 'motion-safe:animate-spin' : undefined} />
						</IconButton>
					)}
					{!integration.builtIn && mayChange && (
						<IconButton label="Disconnect" onClick={() => setDisconnecting(true)}>
							<UnplugIcon />
						</IconButton>
					)}
				</>
			}
		>
			<div className="flex flex-col gap-8">
				{added && <SuccessLine>Connection added successfully</SuccessLine>}
				<Section
					title="Permissions"
					detail={permissionsDetail(integration.custom === true, connection.shared, mayChange)}
				>
					{integration.disclosure && (
						<p className="text-sm text-muted-foreground">{integration.disclosure}</p>
					)}
					{integration.custom && integration.actions.length === 0 && (
						<p className="text-sm text-muted-foreground">The server lists no tools.</p>
					)}
					<ConnectionAccess
						actions={integration.actions}
						defaults={defaultActions(connection)}
						unavailable={connection.unavailable}
						signInNeeded={connection.signInNeeded}
						readOnly={!mayChange}
						differing={differingAgents(agents, connection.id)}
						onChange={async (actions) => {
							const result = await setConnectionDefaults(
								org,
								connection.id,
								defaultsOnOrOff(actions),
							);
							setError(result.isErr() ? describeFetchError(result.error) : null);
							await revalidator.revalidate();
						}}
					/>
					{renew && renewReason && (
						<SignInAgain
							href={renew}
							reason={renewReason}
							onUseKey={integration.apiKey ? () => setReplacingKey(true) : undefined}
						/>
					)}
					{replacingKey && (
						<ConnectWithKeyDialog
							integrationId={integration.id}
							connectionId={connection.id}
							onClose={() => setReplacingKey(false)}
							onConnected={async () => {
								setReplacingKey(false);
								await revalidator.revalidate();
							}}
						/>
					)}
					{connection.integrationId === 'plaid' && mayChange && (
						<SignInToBankAgain connectionId={connection.id} />
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</Section>
				{!integration.builtIn && (
					<Sharing
						orgName={activeOrg.name}
						shared={connection.shared}
						what="connection"
						rows={[
							{label: 'Acts as', value: actingAs},
							{label: 'Connected by', value: connectedBy(connection, human)},
						]}
						alone={!hasOtherPeople(activeOrg)}
						confirmDescription={`Every member's agents in ${activeOrg.name} can use it, as ${actingAs}, with the permissions above. Members see it listed, never its password or token. This can't be undone: to have it as your own again, disconnect it and connect it again.`}
						onShare={async () => {
							const result = await shareConnection(org, connection.id);
							if (result.isErr()) {
								setError(describeApiError(result.error));
								return;
							}
							setError(null);
							await revalidator.revalidate();
						}}
					/>
				)}
				<Section title="Agents with access">
					<RowList>
						{withAccess.length === 0 && <EmptyRows>No agent can reach this connection.</EmptyRows>}
						{withAccess.map((agent) => (
							<Row
								key={agent.id}
								to={`/${org}/agents/${agent.id}`}
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
								to={`/${org}/activity?connection=${connection.id}`}
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
					const result = await deleteConnection(org, connection.id);
					if (result.isErr()) {
						setError(describeFetchError(result.error));
						return;
					}
					navigate(`/${org}/connections`);
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

// What Permissions is about: a custom server's tools, and on a shared connection whose defaults
// they are, and who changes them.
function permissionsDetail(
	custom: boolean,
	shared: boolean,
	mayChange: boolean,
): string | undefined {
	if (shared && !mayChange) {
		return 'every member’s agents’ defaults, changed by whoever connected it and the owner';
	}
	if (shared) {
		return 'what every member’s agents get by default';
	}
	if (custom) {
		return 'The server’s tools, as it last listed them, each allowed on its own';
	}
	return undefined;
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
