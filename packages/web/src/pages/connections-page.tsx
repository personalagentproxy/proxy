import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {SANDBOX_INTEGRATION_ID, VAULT_INTEGRATION_ID} from '@proxy/integrations';
import {PencilIcon, Trash2Icon} from 'lucide-react';
import {useState} from 'react';
import {Link} from 'react-router';
import {deleteConnection, renameConnection} from '@/client/connections-client';
import {AppShell, PageHeader, PageTitle} from '@/components/app-shell';
import {AddButton} from '@/components/add-button';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {OrgNotice} from '@/components/org-notice';
import {RenameDialog} from '@/components/rename-dialog';
import {Row, RowHeader, RowList} from '@/components/row-list';
import {SideEmpty, SideToggle} from '@/components/share-toggle';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {useHuman} from '@/hooks/use-human';
import {useLoaded} from '@/hooks/use-loaded';
import {useReload} from '@/hooks/use-reload';
import {useSide} from '@/hooks/use-side';
import {agentsWithAccess, connectionTitle, integrationOf} from '@/lib/access';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {actsAs, manages} from '@/lib/orgs';
import type {connectionsLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	account: 'hidden w-48 shrink-0 truncate text-right text-muted-foreground md:block',
	actsAs: 'hidden w-48 shrink-0 truncate text-right text-muted-foreground md:block',
	agents: 'w-20 shrink-0 text-right text-muted-foreground tabular-nums',
};

const LINK = 'text-foreground underline underline-offset-4';

// What a row's context menu is about: the connection, and whether it is being renamed or deleted.
type Pending = {connection: Connection; action: 'rename' | 'delete'};

// A custom MCP server and a vault a member made have nothing else to be called.
function needsName(connection: Connection): boolean {
	const integration = integrationOf(connection);
	return integration?.custom === true || integration?.native === true;
}

// The services connected in the organization open that the person uses: their own and those
// shared with them, never another member's that isn't. With anyone else in it or invited, a toggle
// picks the list, in the address as `?for=me` or `?for=everyone`: what is theirs alone, or what is
// shared, by them or with them, with every member or some by name, opening on what is theirs
// alone, the shared one saying who the provider sees when an agent uses each. The person's own
// vault and Sandboxes come first among what is theirs alone, each opening its connection's page,
// as every connection does, where what it holds is the first tab. A right click on a row renames or deletes a connection the person may change: their own, or, as the organization's owner, one
// shared with every member.
export function ConnectionsPage() {
	return (
		<AppShell title={<PageTitle>Connections</PageTitle>}>
			<Connections />
		</AppShell>
	);
}

function Connections() {
	const org = useOrgSlug();
	const {connections: all, agents} = useLoaded<typeof connectionsLoader>();
	const reload = useReload();
	const human = useHuman();
	const [pending, setPending] = useState<Pending | null>(null);
	const [error, setError] = useState<string | null>(null);
	const listed = all.filter((connection) => !connection.builtIn);
	const side = useSide(listed, {opensOnShared: false});
	if (!human) {
		return null;
	}

	// The person's built-in ones are theirs alone, so on that side.
	const builtIn = (integrationId: string) =>
		all.filter(
			(connection) =>
				connection.builtIn && connection.integrationId === integrationId && !side.shared,
		);
	const vaults = builtIn(VAULT_INTEGRATION_ID);
	const sandboxes = builtIn(SANDBOX_INTEGRATION_ID);

	const activeOrg = human.org;
	const connections = side.shown;
	const showingShared = side.shared;
	const renaming = pending?.action === 'rename' ? pending.connection : null;
	const deleting = pending?.action === 'delete' ? pending.connection : null;

	return (
		<>
			<PageHeader
				actions={
					<AddButton
						label="Add connection"
						to={showingShared ? `/${org}/connections/new?for=everyone` : `/${org}/connections/new`}
					/>
				}
			/>
			<OrgNotice />
			<SideToggle side={side} orgName={activeOrg.name} sharedLabel="Shared" />
			{error && <p className="text-sm text-destructive">{error}</p>}
			<RowList
				header={
					<RowHeader>
						<span className="size-5 shrink-0" />
						<span className="min-w-0 flex-1">Service</span>
						<span className={CELLS.account}>Account</span>
						{showingShared && <span className={CELLS.actsAs}>Acts as</span>}
						<span className={CELLS.agents}>Agents</span>
					</RowHeader>
				}
			>
				<BuiltInRow connections={vaults} agents={agents} />
				<BuiltInRow connections={sandboxes} agents={agents} />
				{connections.length === 0 && (
					<SideEmpty
						side={side}
						alone={
							<>
								Nothing connected yet.{' '}
								<Link to={`/${org}/connections/new`} className={LINK}>
									Add a connection
								</Link>{' '}
								or{' '}
								<Link to={`/${org}/members`} className={LINK}>
									invite people
								</Link>{' '}
								to share them with.
							</>
						}
						shared={`Nothing shared in ${activeOrg.name} yet.`}
						own={`Nothing else of your own in ${activeOrg.name} yet.`}
					/>
				)}
				{connections.map((connection) => {
					const integration = integrationOf(connection);
					return (
						<Row
							key={connection.id}
							to={`/${org}/connections/${connection.id}`}
							icon={integration && <IntegrationLogo integration={integration} />}
							title={connectionTitle(connection)}
							cells={
								<>
									<span className={CELLS.account}>{connection.account}</span>
									{showingShared && (
										<span className={CELLS.actsAs}>
											{integration?.native ? '' : actsAs(connection, human)}
										</span>
									)}
									<span className={CELLS.agents}>
										{agentsWithAccess(agents, connection).length}
									</span>
								</>
							}
							menu={
								manages(human, connection) && (
									<>
										<ContextMenuItem onClick={() => setPending({connection, action: 'rename'})}>
											<PencilIcon />
											Rename…
										</ContextMenuItem>
										<ContextMenuItem
											variant="destructive"
											onClick={() => setPending({connection, action: 'delete'})}
										>
											<Trash2Icon />
											Delete…
										</ContextMenuItem>
									</>
								)
							}
						/>
					);
				})}
			</RowList>
			{renaming && (
				<RenameDialog
					key={renaming.id}
					open
					title={`Rename ${connectionTitle(renaming)}`}
					description={
						needsName(renaming)
							? 'What this connection is called here and to agents.'
							: `What this connection is called here and to agents. Leave it empty to call it ${integrationOf(renaming)?.name ?? 'by its service'} again.`
					}
					initial={renaming.name ?? ''}
					allowEmpty={!needsName(renaming)}
					onClose={() => setPending(null)}
					onSave={async (name) => {
						const result = await renameConnection(org, renaming.id, name);
						if (result.isErr()) {
							return describeApiError(result.error);
						}
						await reload();
						return null;
					}}
				/>
			)}
			<ConfirmDialog
				open={deleting !== null}
				title={deleting ? `Delete ${connectionTitle(deleting)}?` : ''}
				description={
					deleting && integrationOf(deleting)?.native
						? 'Its entries are deleted with it, for good, and agents lose it at once.'
						: deleting
							? `Agents lose access to ${deleting.account} at once, and the access you gave them here is forgotten. You can connect it again later.`
							: ''
				}
				confirmLabel="Delete"
				destructive
				onClose={() => setPending(null)}
				onConfirm={async () => {
					if (!deleting) {
						return;
					}
					const result = await deleteConnection(org, deleting.id);
					setError(result.isErr() ? describeFetchError(result.error) : null);
					await reload();
				}}
			/>
		</>
	);
}

// The person's built-in connection of an integration as a row, their vault or their Sandboxes,
// kept in Personal Agent Proxy, so never renamed, shared or deleted, opening its connection's
// page; none without one, as an organization not offered sandboxes has.
function BuiltInRow({connections, agents}: {connections: Connection[]; agents: AgentLogin[]}) {
	const org = useOrgSlug();
	const [first] = connections;
	const integration = first && integrationOf(first);
	if (!first || !integration) {
		return null;
	}

	return (
		<Row
			to={`/${org}/connections/${first.id}`}
			icon={<IntegrationLogo integration={integration} />}
			title={connectionTitle(first)}
			cells={
				<>
					<span className={CELLS.account}>{first.account}</span>
					<span className={CELLS.agents}>{agentsWithAccess(agents, first).length}</span>
				</>
			}
		/>
	);
}
