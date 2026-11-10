import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {VAULT_INTEGRATION_ID} from '@proxy/integrations';
import {ListRestartIcon, RefreshCwIcon, UnplugIcon} from 'lucide-react';
import type {FetchError} from '@proxy/utils';
import {type ReactNode, useState} from 'react';
import {Link, useLoaderData, useNavigate, useRevalidator, useSearchParams} from 'react-router';
import {
	deleteConnection,
	refreshMcpTools,
	setConnectionDefaults,
	setConnectionSharing,
} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditList} from '@/components/audit-list';
import {SignInToBankAgain} from '@/components/connect-bank-form';
import {ConnectWithKeyDialog} from '@/components/connect-with-key-dialog';
import {ConnectionAccess, SignInAgain} from '@/components/connection-access';
import {ConnectionSharing} from '@/components/connection-sharing';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {IconButton} from '@/components/icon-button';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {NotFound} from '@/components/not-found';
import {PageTabs} from '@/components/page-tabs';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {SuccessLine} from '@/components/success-line';
import {
	actionsFor,
	agentsWithAccess,
	connectionTitle,
	defaultActions,
	defaultsOnOrOff,
	integrationOf,
	ownSettings,
	describeActions,
} from '@/lib/access';
import {buttonVariants} from '@proxy/ui/components/button';
import {useHuman} from '@/hooks/use-human';
import {signInPath} from '@/lib/integrations';
import {chosenTab, type PageTab} from '@/lib/page-tabs';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {actsAs, hasOtherPeople, manages, ownerOf, vaultPath} from '@/lib/orgs';
import type {connectionLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

const RECENT = 10;

export function ConnectionPage() {
	const org = useOrgSlug();
	const {connection, connections, agents, entries, tasks, members} =
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
		return <NotFound what="connection" />;
	}

	const withAccess = agentsWithAccess(agents, connection);
	const activeOrg = human.org;
	// One's own connection is one's to change and share, and one shared with every member is the
	// organization's owner's too. Anyone else it is shared with uses it as it is.
	const mayChange = manages(human, connection);
	// A vault's entries are kept here, so no provider sees anyone.
	const actingAs = integration.native ? null : actsAs(connection, human);
	// A vault a member made is deleted, with its entries, where another connection is disconnected.
	// The page's parts, one shown at a time: a built-in connection, which is never shared, has no
	// Sharing.
	const tabs: Array<PageTab<'permissions' | 'sharing' | 'agents' | 'activity'>> = [
		{id: 'permissions', label: 'Permissions'},
		...(connection.builtIn ? [] : [{id: 'sharing' as const, label: 'Sharing'}]),
		{id: 'agents', label: 'Agents', count: withAccess.length},
		{id: 'activity', label: 'Recent activity'},
	];
	const tab = chosenTab(tabs, searchParams);
	const about = permissionsIntro(connection, {
		custom: integration.custom === true,
		mayChange,
		owner: ownerOf(connection, human),
	});
	const removal = integration.native
		? {
				verb: 'Delete',
				description: `Its entries are deleted with it, for good, and agents lose it at once.`,
			}
		: {
				verb: 'Disconnect',
				description: `Agents lose access to ${connection.account} at once, and the access you gave them here is forgotten. You can connect it again later.`,
			};
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
				<PageTitle
					detail={
						connection.name === null
							? connection.account
							: `${integration.name} · ${connection.account}`
					}
				>
					<span className="flex items-center gap-2">
						<IntegrationLogo integration={integration} />
						{connectionTitle(connection)}
					</span>
				</PageTitle>
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
					{integration.id === VAULT_INTEGRATION_ID && (
						<Link
							to={vaultPath(org, connection)}
							className={buttonVariants({variant: 'outline', size: 'sm'})}
						>
							Open entries
						</Link>
					)}
					{!connection.builtIn && mayChange && (
						<IconButton label={removal.verb} onClick={() => setDisconnecting(true)}>
							<UnplugIcon />
						</IconButton>
					)}
				</>
			}
		>
			<div className="flex flex-col gap-4">
				{added && <SuccessLine>Connection added successfully</SuccessLine>}
				<PageTabs tabs={tabs} chosen={tab} label="Connection" />
				{tab === 'permissions' && (
					<div className="flex flex-col gap-2">
						<p className="text-sm text-muted-foreground">{about}</p>
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
							differing={differingAgents(org, agents, connection.id)}
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
						{integration.form === 'bank' && mayChange && (
							<SignInToBankAgain connectionId={connection.id} />
						)}
					</div>
				)}
				{tab === 'sharing' && (
					<ConnectionSharing
						orgName={activeOrg.name}
						connection={connection}
						what={integration.native ? 'vault' : 'connection'}
						members={members}
						userId={human.user.id}
						actsAs={actingAs}
						mayChange={mayChange}
						alone={!hasOtherPeople(activeOrg)}
						onChange={async (sharing) => {
							const result = await setConnectionSharing(org, connection.id, sharing);
							setError(result.isErr() ? describeApiError(result.error) : null);
							await revalidator.revalidate();
						}}
					/>
				)}
				{tab === 'agents' && (
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
				)}
				{tab === 'activity' && (
					<div className="flex flex-col gap-2">
						<div className="flex min-h-8 items-center justify-between gap-4 text-sm text-muted-foreground">
							<span>
								{entries.length > RECENT ? (
									<Link
										to={`/${org}/activity?connection=${connection.id}`}
										className="underline-offset-4 hover:text-foreground hover:underline"
									>
										Go to all activity
									</Link>
								) : (
									'What agents did with it, the latest first'
								)}
							</span>
							<IconButton
								label={revalidator.state === 'loading' ? 'Refreshing activity' : 'Refresh activity'}
								size="xs"
								disabled={revalidator.state === 'loading'}
								onClick={() => void revalidator.revalidate()}
							>
								<RefreshCwIcon
									className={
										revalidator.state === 'loading' ? 'motion-safe:animate-spin' : undefined
									}
								/>
							</IconButton>
						</div>
						<AuditList
							entries={entries.slice(0, RECENT)}
							agents={agents}
							connections={connections}
							tasks={tasks}
							showConnection={false}
						/>
					</div>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
			</div>
			<ConfirmDialog
				open={disconnecting}
				title={`${removal.verb} ${connectionTitle(connection)}?`}
				description={removal.description}
				confirmLabel={removal.verb}
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

// What the Permissions tab says first: that these are what agents get unless they have a setting
// of their own, whose agents those are, and who sets them.
function permissionsIntro(
	connection: Connection,
	about: {custom: boolean; mayChange: boolean; owner: string},
): string {
	const whose = connection.shared ? 'the agents of everyone who uses it' : 'your agents';
	return [
		`What ${whose} may do with it by default. An agent’s own settings, on its page, come first.`,
		...(about.custom ? ['These are the server’s tools, as it last listed them.'] : []),
		...(about.mayChange ? [] : [`${about.owner} sets these.`]),
	].join(' ');
}

// The agents, revoked ones left out, with a setting of their own for each action, as the end of
// the action's row shows them: their logos, each a link to the agent, where the setting is.
function differingAgents(
	org: string,
	agents: AgentLogin[],
	connectionId: string,
): Partial<Record<string, ReactNode>> {
	const byAction: Partial<Record<string, AgentLogin[]>> = {};
	for (const agent of agents) {
		if (agent.revokedAt !== null) {
			continue;
		}
		for (const actionId of Object.keys(ownSettings(agent, connectionId))) {
			byAction[actionId] = [...(byAction[actionId] ?? []), agent];
		}
	}
	return Object.fromEntries(
		Object.entries(byAction).map(([actionId, differing = []]) => [
			actionId,
			<span key={actionId} className="flex items-center gap-1.5">
				<span className="hidden md:inline">Differs for</span>
				{differing.map((agent) => (
					<Link
						key={agent.id}
						to={`/${org}/agents/${agent.id}`}
						title={agent.name}
						aria-label={`${agent.name} has its own setting`}
						className="rounded-md outline-none hover:opacity-80 focus-visible:ring-3 focus-visible:ring-ring/50"
					>
						<AgentLogo providerId={agent.providerId} />
					</Link>
				))}
			</span>,
		]),
	);
}
