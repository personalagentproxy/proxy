import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {
	FILES_INTEGRATION_ID,
	SANDBOX_INTEGRATION_ID,
	VAULT_INTEGRATION_ID,
} from '@proxy/integrations';
import {ForwardIcon, PencilIcon, Trash2Icon} from 'lucide-react';
import {useState} from 'react';
import {Link} from 'react-router';
import {deleteConnection, moveConnection, renameConnection} from '@/client/connections-client';
import {AppShell, PageHeader, PageTitle} from '@/components/app-shell';
import {AddButton} from '@/components/add-button';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {MoveConnectionDialog} from '@/components/move-connection-dialog';
import {OrgNotice} from '@/components/org-notice';
import {RenameDialog} from '@/components/rename-dialog';
import {Row, RowHeader, RowList} from '@/components/row-list';
import {SideEmpty, SideToggle} from '@/components/share-toggle';
import {PersonHead, PersonHeads} from '@/components/person-heads';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {useHuman} from '@/hooks/use-human';
import {useLoaded} from '@/hooks/use-loaded';
import {useReload} from '@/hooks/use-reload';
import {useSide} from '@/hooks/use-side';
import {
	agentsWithAccess,
	connectionTitle,
	integrationOf,
	ownerOfConnection,
	sharedWithPeople,
} from '@/lib/access';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {manages} from '@/lib/orgs';
import type {connectionsLoader} from '@/loaders';
import {useOrgSlug} from '@/hooks/use-org';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	account: 'hidden w-48 shrink-0 truncate text-right text-muted-foreground md:block',
	connectedBy: 'hidden w-24 shrink-0 justify-end md:flex',
	sharedWith: 'hidden w-24 shrink-0 justify-end md:flex',
	agents: 'w-20 shrink-0 text-right text-muted-foreground tabular-nums',
};

const LINK = 'text-foreground underline underline-offset-4';

// What a row's context menu is about: the connection, and whether it is being renamed, moved into
// another organization or deleted.
type Pending = {connection: Connection; action: 'rename' | 'move' | 'delete'};

// What deleting a connection from its row's menu takes with it: what a vault or a drive a member
// made holds, or, for a service connected, the access given here.
function deletingSays(connection: Connection): string {
	const made = integrationOf(connection)?.made;
	if (made) {
		return `Its ${made.holds} are deleted with it, for good, and agents lose it at once.`;
	}
	return `Agents lose access to ${connection.account} at once, and the access you gave them here is forgotten. You can connect it again later.`;
}

// A custom MCP server, and a vault or a drive a member made, have nothing else to be called.
function needsName(connection: Connection): boolean {
	const integration = integrationOf(connection);
	return integration?.custom === true || integration?.made !== undefined;
}

// The services connected in the organization open that the person uses: their own and those
// shared with them, never another member's that isn't. With anyone else in it or invited, a toggle
// picks the list, in the address as `?for=me` or `?for=everyone`: what is theirs alone, or what is
// shared, by them or with them, with every member or some by name, opening on what is theirs
// alone, the shared one showing the face of who connected each, whose account agents act as, and
// the faces of who it is shared with. The person's own vault and Sandboxes come first among what
// is theirs alone, each opening its connection's page, as every connection does, where what it
// holds is the first tab. A right click on a row renames or deletes a connection the person may
// change: their own, or, as the organization's owner, one shared with every member; and, in
// someone with another organization, moves their own into it.
export function ConnectionsPage() {
	return (
		<AppShell title={<PageTitle>Connections and permissions</PageTitle>}>
			<Connections />
		</AppShell>
	);
}

function Connections() {
	const org = useOrgSlug();
	const {connections: all, agents, members} = useLoaded<typeof connectionsLoader>();
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
	const drives = builtIn(FILES_INTEGRATION_ID);

	const activeOrg = human.org;
	const connections = side.shown;
	const showingShared = side.shared;
	const renaming = pending?.action === 'rename' ? pending.connection : null;
	const moving = pending?.action === 'move' ? pending.connection : null;
	const deleting = pending?.action === 'delete' ? pending.connection : null;
	// Where the person's own connections can move: their other organizations.
	const otherOrgs = human.orgs.filter((other) => other.id !== activeOrg.id);

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
						{showingShared && <span className={CELLS.connectedBy}>Connected by</span>}
						{showingShared && <span className={CELLS.sharedWith}>Shared with</span>}
						<span className={CELLS.agents}>Agents</span>
					</RowHeader>
				}
			>
				<BuiltInRow connections={vaults} agents={agents} />
				<BuiltInRow connections={sandboxes} agents={agents} />
				<BuiltInRow connections={drives} agents={agents} />
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
										<span className={CELLS.connectedBy}>
											<PersonHead person={ownerOfConnection(connection, members)} />
										</span>
									)}
									{showingShared && (
										<span className={CELLS.sharedWith}>
											<PersonHeads people={sharedWithPeople(connection, members)} />
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
											Rename
										</ContextMenuItem>
										{connection.ownerUserId === human.user.id && otherOrgs.length > 0 && (
											<ContextMenuItem onClick={() => setPending({connection, action: 'move'})}>
												<ForwardIcon />
												Move
											</ContextMenuItem>
										)}
										<ContextMenuItem
											variant="destructive"
											onClick={() => setPending({connection, action: 'delete'})}
										>
											<Trash2Icon />
											Delete
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
			{moving && (
				<MoveConnectionDialog
					key={moving.id}
					title={connectionTitle(moving)}
					orgs={otherOrgs}
					onClose={() => setPending(null)}
					onMove={async (slug) => {
						const result = await moveConnection(org, moving.id, slug);
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
				description={deleting ? deletingSays(deleting) : ''}
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
