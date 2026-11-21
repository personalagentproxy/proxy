import type {Connection} from '@proxy/contracts/connections';
import {ListRestartIcon, LockIcon, UnplugIcon} from 'lucide-react';
import type {FetchError} from '@proxy/utils';
import {useState} from 'react';
import {useNavigate, useSearchParams} from 'react-router';
import {setAgentGrants} from '@/client/agents-client';
import {
	deleteConnection,
	refreshMcpTools,
	setConnectionDefaults,
	setConnectionSharing,
} from '@/client/connections-client';
import {AccessGrid, type GridAgent} from '@/components/access-grid';
import {AppShell, PageHeader, PageTitle} from '@/components/app-shell';
import {SignInToBankAgain} from '@/components/connect-bank-form';
import {ConnectWithKeyDialog} from '@/components/connect-with-key-dialog';
import {SignInAgain} from '@/components/connection-access';
import {ConnectionSharing} from '@/components/connection-sharing';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {GitHubRepositories} from '@/components/github-repositories';
import {IconButton} from '@/components/icon-button';
import {IntegrationLogo} from '@/components/brand-logo';
import {NotFound} from '@/components/not-found';
import {PageTabs} from '@/components/page-tabs';
import {RecentActivity} from '@/components/recent-activity';
import {DriveHistory} from '@/components/drive-history';
import {FileBrowser} from '@/components/file-browser';
import {SandboxList} from '@/components/sandbox-list';
import {SuccessLine} from '@/components/success-line';
import {VaultEntries} from '@/components/vault-entries';
import {
	connectionTitle,
	defaultActions,
	integrationOf,
	isBuiltInAgent,
	ownSettings,
	reaches,
} from '@/lib/access';
import {useHuman} from '@/hooks/use-human';
import {reachedRepositories} from '@/lib/github';
import {useLoaded} from '@/hooks/use-loaded';
import {useReload} from '@/hooks/use-reload';
import {signInPath} from '@/lib/integrations';
import {chosenTab, type PageTab} from '@/lib/page-tabs';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {
	actsAs,
	agentSetBy,
	connectionSetBy,
	hasOtherPeople,
	manages,
	managesAgentSettings,
} from '@/lib/orgs';
import type {connectionLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

export function ConnectionPage() {
	return (
		<AppShell loadsTitle>
			<ConnectionDetail />
		</AppShell>
	);
}

function ConnectionDetail() {
	const org = useOrgSlug();
	const {
		connection,
		connections,
		agents,
		entries,
		tasks,
		members,
		vaultEntries,
		sandboxes,
		github,
		files,
		history,
	} = useLoaded<typeof connectionLoader>();
	const navigate = useNavigate();
	const reload = useReload();
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

	// The agents that reach it, a column each of its permissions: the person's own, the shared ones
	// where every member has it, theirs to change where the agent is, and Chat, the one the Chat
	// page's personas all act through, theirs to change on any connection they use, for everyone's
	// Chat there. Where a column isn't theirs, it names who changes it.
	const columns: GridAgent[] = agents
		.filter((agent) => agent.revokedAt === null && reaches(agent, connection))
		.map((agent) => ({
			agent,
			own: ownSettings(agent, connection.id),
			setBy: managesAgentSettings(human, agent) ? null : agentSetBy(agent, members),
		}));
	const activeOrg = human.org;
	// One's own connection is one's to change and share, and one shared with every member is the
	// organization's owner's too. Anyone else it is shared with uses it as it is.
	const mayChange = manages(human, connection);
	const defaultsSetBy = mayChange ? null : connectionSetBy(connection, members);
	// A vault's entries are kept here, so no provider sees anyone.
	const actingAs = integration.native ? null : actsAs(connection, human);
	// A vault a member made is deleted, with its entries, where another connection is disconnected.
	// The page's parts, one shown at a time: what a vault, the Sandboxes or a drive hold comes
	// first, being what it is opened for; the repositories a GitHub connection reaches, and the
	// history a Google connection keeps of its files in Drive, follow its Permissions; and a built-in
	// connection, which is never shared, has no Sharing.
	const tabs: Array<
		PageTab<
			| 'entries'
			| 'sandboxes'
			| 'files'
			| 'repositories'
			| 'history'
			| 'permissions'
			| 'sharing'
			| 'activity'
		>
	> = [
		...(vaultEntries === null
			? []
			: [{id: 'entries' as const, label: 'Entries', count: vaultEntries.length}]),
		...(sandboxes === null
			? []
			: [{id: 'sandboxes' as const, label: 'Sandboxes', count: sandboxes.length}]),
		...(files === null ? [] : [{id: 'files' as const, label: 'Files'}]),
		{id: 'permissions', label: 'Permissions'},
		...(github === null
			? []
			: [{id: 'repositories' as const, label: 'Repositories', count: reachedRepositories(github)}]),
		...(history === null ? [] : [{id: 'history' as const, label: 'File history'}]),
		...(connection.builtIn ? [] : [{id: 'sharing' as const, label: 'Sharing'}]),
		{id: 'activity', label: 'Recent activity'},
	];
	const tab = chosenTab(tabs, searchParams);
	const about = permissionsIntro(connection, integration.custom === true);
	const locked = lockedNote(defaultsSetBy, columns);
	const removal = integration.made
		? {
				verb: 'Delete',
				description: `Its ${integration.made.holds} are deleted with it, for good, and agents lose it at once.`,
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
		<>
			<PageHeader
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
									await reload();
								}}
							>
								<ListRestartIcon className={refreshing ? 'motion-safe:animate-spin' : undefined} />
							</IconButton>
						)}
						{!connection.builtIn && mayChange && (
							<IconButton label={removal.verb} onClick={() => setDisconnecting(true)}>
								<UnplugIcon />
							</IconButton>
						)}
					</>
				}
			/>
			<div className="flex flex-col gap-4">
				{added && <SuccessLine>Connection added successfully</SuccessLine>}
				{renewReason === 'needed' && (
					<SignInAgain
						href={renew}
						reason={renewReason}
						onUseKey={integration.apiKey ? () => setReplacingKey(true) : undefined}
						connectedBy={
							connection.ownerUserId === human.user.id
								? undefined
								: (connection.owner ?? 'a former member')
						}
					/>
				)}
				{replacingKey && (
					<ConnectWithKeyDialog
						integrationId={integration.id}
						connectionId={connection.id}
						onClose={() => setReplacingKey(false)}
						onConnected={async () => {
							setReplacingKey(false);
							await reload();
						}}
					/>
				)}
				<PageTabs tabs={tabs} chosen={tab} label="Connection" />
				{tab === 'entries' && vaultEntries !== null && (
					<VaultEntries
						connectionId={connection.id}
						entries={vaultEntries}
						made={!connection.builtIn}
					/>
				)}
				{tab === 'sandboxes' && sandboxes !== null && (
					<SandboxList connectionId={connection.id} sandboxes={sandboxes} />
				)}
				{tab === 'files' && files !== null && (
					<FileBrowser
						connectionId={connection.id}
						place={files.place}
						list={files.list}
						shown={files.shown}
					/>
				)}
				{tab === 'repositories' && github !== null && (
					<GitHubRepositories
						account={connection.account}
						shared={connection.shared}
						reach={github}
					/>
				)}
				{tab === 'history' && history !== null && (
					<DriveHistory connectionId={connection.id} history={history} />
				)}
				{tab === 'permissions' && (
					<div className="flex flex-col gap-2">
						<p className="text-sm text-muted-foreground">{about}</p>
						{locked && (
							<p className="flex items-start gap-2 text-sm text-muted-foreground">
								<span className="flex h-5 shrink-0 items-center">
									<LockIcon className="size-3.5" />
								</span>
								{locked}
							</p>
						)}
						{integration.disclosure && (
							<p className="text-sm text-muted-foreground">{integration.disclosure}</p>
						)}
						{integration.custom && integration.actions.length === 0 && (
							<p className="text-sm text-muted-foreground">The server lists no tools.</p>
						)}
						<AccessGrid
							actions={integration.actions}
							defaults={defaultActions(connection)}
							agents={columns}
							unavailable={connection.unavailable}
							signInNeeded={connection.signInNeeded}
							defaultsSetBy={defaultsSetBy}
							all
							onChangeDefaults={async (actions) => {
								const result = await setConnectionDefaults(org, connection.id, actions);
								setError(result.isErr() ? describeFetchError(result.error) : null);
								await reload();
							}}
							onChangeAgent={async (agentId, actions) => {
								const result = await setAgentGrants(org, agentId, connection.id, actions);
								setError(result.isErr() ? describeApiError(result.error) : null);
								await reload();
							}}
						/>
						{renew && (renewReason === 'renew' || renewReason === 'unavailable') && (
							<SignInAgain
								href={renew}
								reason={renewReason}
								onUseKey={integration.apiKey ? () => setReplacingKey(true) : undefined}
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
						what={integration.made?.one ?? 'connection'}
						members={members}
						userId={human.user.id}
						actsAs={actingAs}
						warning={integration.sharingWarning}
						mayChange={mayChange}
						alone={!hasOtherPeople(activeOrg)}
						onChange={async (sharing) => {
							const result = await setConnectionSharing(org, connection.id, sharing);
							setError(result.isErr() ? describeApiError(result.error) : null);
							await reload();
						}}
					/>
				)}
				{tab === 'activity' && (
					<RecentActivity
						entries={entries}
						agents={agents}
						connections={connections}
						tasks={tasks}
						allHref={`/${org}/activity?connection=${connection.id}`}
						of="connection"
					/>
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
		</>
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

// What the Permissions tab says first: what the grid's columns are, and whose agents those are.
function permissionsIntro(connection: Connection, custom: boolean): string {
	const whose = connection.shared ? 'The agents of everyone who uses it' : 'Your agents';
	return [
		`${whose} get what Default says, unless a box of the agent’s own says otherwise.`,
		...(custom ? ['These are the server’s tools, as it last listed them.'] : []),
	].join(' ');
}

// For someone a connection is shared with, who doesn't change it: who sets Default, and what they
// set themselves, beyond Default if they like: Chat's column, which holds for everyone's Chat on
// the connection, and their own agents'. Null where the defaults are theirs to set.
function lockedNote(defaultsSetBy: string | null, columns: GridAgent[]): string | null {
	if (defaultsSetBy === null) {
		return null;
	}
	const sets = `${defaultsSetBy} sets Default here.`;
	const chat = columns.some(({agent}) => isBuiltInAgent(agent));
	const yours = columns.some(({agent, setBy}) => setBy === null && !isBuiltInAgent(agent));
	if (chat && yours) {
		return `${sets} You set Chat’s column, for everyone’s Chat on it, and your own agents’, beyond Default if you like.`;
	}
	if (chat) {
		return `${sets} You set Chat’s column, for everyone’s Chat on it, beyond Default if you like.`;
	}
	if (yours) {
		return `${sets} You set your own agents’ columns, beyond Default if you like.`;
	}
	return `${sets} Ask them to change what agents may do with it.`;
}
