import {VAULT_INTEGRATION_ID} from '@proxy/integrations';
import {PencilIcon, PlusIcon, Trash2Icon} from 'lucide-react';
import {useState} from 'react';
import {Link, useLoaderData, useRevalidator} from 'react-router';
import {deleteConnection, renameConnection} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {OrgNotice} from '@/components/org-notice';
import {RenameDialog} from '@/components/rename-dialog';
import {Row, RowHeader, RowList} from '@/components/row-list';
import {SideEmpty, SideToggle} from '@/components/share-toggle';
import {Button} from '@proxy/ui/components/button';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {useHuman} from '@/hooks/use-human';
import {useSide} from '@/hooks/use-side';
import {agentsWithAccess, integrationOf} from '@/lib/access';
import {describeApiError, describeFetchError} from '@/lib/loader-utils';
import {actsAs, manages} from '@/lib/orgs';
import type {AgentLogin, Connection} from '@/lib/types';
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

// What a connection is called: the name the person gave it, else its integration.
function titleOf(connection: Connection): string {
	return connection.name ?? integrationOf(connection)?.name ?? connection.integrationId;
}

// The services connected in the organization open: its shared ones and the person's own, never
// another member's. With anyone else in it or invited, a toggle picks the list, in the address as
// `?for=me` or `?for=everyone`, opening on the shared one unless only the person's own has any, the
// shared one saying who the provider sees when an agent uses each. The vault comes first, the
// person's own or the organization's as the list shows, both alone, opening its own page. A right
// click on a row renames or deletes a connection the person may change: their own, or a shared one
// they connected or whose organization they own.
export function ConnectionsPage() {
	const org = useOrgSlug();
	const {connections: all, agents} = useLoaderData<typeof connectionsLoader>();
	const revalidator = useRevalidator();
	const human = useHuman();
	const [pending, setPending] = useState<Pending | null>(null);
	const [error, setError] = useState<string | null>(null);
	const listed = all.filter((connection) => !integrationOf(connection)?.builtIn);
	const side = useSide(listed, {opensOnShared: true});
	if (!human) {
		return null;
	}

	const vaults = all.filter(
		(connection) =>
			connection.integrationId === VAULT_INTEGRATION_ID &&
			(!side.others || connection.shared === side.shared),
	);

	const activeOrg = human.org;
	const connections = side.shown;
	const showingShared = side.shared;
	const renaming = pending?.action === 'rename' ? pending.connection : null;
	const deleting = pending?.action === 'delete' ? pending.connection : null;

	return (
		<AppShell
			title={<PageTitle detail={`${listed.length} connected`}>Connections</PageTitle>}
			actions={
				<Button
					size="sm"
					nativeButton={false}
					render={
						<Link
							to={
								showingShared ? `/${org}/connections/new?for=everyone` : `/${org}/connections/new`
							}
						/>
					}
				>
					<PlusIcon data-icon="inline-start" />
					Add connection
				</Button>
			}
		>
			<OrgNotice />
			<SideToggle side={side} orgName={activeOrg.name} />
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
				<VaultRow vaults={vaults} agents={agents} showingShared={showingShared} />
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
						shared={`Nothing shared with ${activeOrg.name} yet.`}
						own={`Nothing of your own in ${activeOrg.name} yet.`}
					/>
				)}
				{connections.map((connection) => {
					const integration = integrationOf(connection);
					return (
						<Row
							key={connection.id}
							to={`/${org}/connections/${connection.id}`}
							icon={integration && <IntegrationLogo integration={integration} />}
							title={titleOf(connection)}
							cells={
								<>
									<span className={CELLS.account}>{connection.account}</span>
									{showingShared && (
										<span className={CELLS.actsAs}>{actsAs(connection, human)}</span>
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
					title={`Rename ${titleOf(renaming)}`}
					description={
						integrationOf(renaming)?.custom
							? 'What this connection is called here and to agents.'
							: `What this connection is called here and to agents. Leave it empty to call it ${integrationOf(renaming)?.name ?? 'by its service'} again.`
					}
					initial={renaming.name ?? ''}
					allowEmpty={!integrationOf(renaming)?.custom}
					onClose={() => setPending(null)}
					onSave={async (name) => {
						const result = await renameConnection(org, renaming.id, name);
						if (result.isErr()) {
							return describeApiError(result.error);
						}
						await revalidator.revalidate();
						return null;
					}}
				/>
			)}
			<ConfirmDialog
				open={deleting !== null}
				title={deleting ? `Delete ${titleOf(deleting)}?` : ''}
				description={
					deleting
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
					await revalidator.revalidate();
				}}
			/>
		</AppShell>
	);
}

// The vault the list shows, or both alone, as one row: what agents know, kept in Personal Agent
// Proxy, so never renamed or deleted. Its page opens on the same side.
function VaultRow({
	vaults,
	agents,
	showingShared,
}: {
	vaults: Connection[];
	agents: AgentLogin[];
	showingShared: boolean;
}) {
	const org = useOrgSlug();
	const human = useHuman();
	const [first] = vaults;
	const integration = first && integrationOf(first);
	if (!first || !integration || !human) {
		return null;
	}

	const withAccess = new Set(
		vaults.flatMap((vault) => agentsWithAccess(agents, vault).map((agent) => agent.id)),
	);
	const side = vaults.length > 1 ? '' : `?for=${first.shared ? 'everyone' : 'me'}`;

	return (
		<Row
			to={`/${org}/connections/vault${side}`}
			icon={<IntegrationLogo integration={integration} />}
			title={integration.name}
			cells={
				<>
					<span className={CELLS.account}>{first.account}</span>
					{showingShared && <span className={CELLS.actsAs}>{actsAs(first, human)}</span>}
					<span className={CELLS.agents}>{withAccess.size}</span>
				</>
			}
		/>
	);
}
