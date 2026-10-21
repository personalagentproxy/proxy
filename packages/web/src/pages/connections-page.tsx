import {PencilIcon, PlusIcon, Trash2Icon} from 'lucide-react';
import {useState} from 'react';
import {Link, useLoaderData, useRevalidator} from 'react-router';
import {deleteConnection, renameConnection} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {OrgNotice} from '@/components/org-notice';
import {RenameDialog} from '@/components/rename-dialog';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Badge} from '@proxy/ui/components/badge';
import {Button} from '@proxy/ui/components/button';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {agentsWithAccess, integrationOf} from '@/lib/access';
import {apiMessage} from '@/lib/agent-errors';
import {describeFetchError} from '@/lib/loader-utils';
import type {Connection} from '@/lib/types';
import type {connectionsLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	account:
		'flex min-w-0 max-w-48 flex-1 items-center justify-end gap-1.5 text-right text-muted-foreground md:w-48 md:flex-none',
	agents: 'hidden w-20 shrink-0 text-right text-muted-foreground tabular-nums sm:block',
};

// What a row's context menu is about: the connection, and whether it is being renamed or deleted.
type Pending = {connection: Connection; action: 'rename' | 'delete'};

// What a connection is called: the name the person gave it, else its integration.
function titleOf(connection: Connection): string {
	return connection.name ?? integrationOf(connection)?.name ?? connection.integrationId;
}

// Built-in integrations are one service even when several accounts are connected. Each custom MCP
// server is a service of its own, despite sharing the catalog's `mcp` integration id.
function groupOf(connection: Connection): string {
	return integrationOf(connection)?.custom ? connection.id : connection.integrationId;
}

// One connection's account, followed by how many other accounts use the same service. The tooltip
// spells every account out while the row itself still opens this particular connection.
function AccountCell({connection, siblings}: {connection: Connection; siblings: Connection[]}) {
	if (siblings.length < 2) {
		return (
			<span className={CELLS.account}>
				<span className="truncate">{connection.account}</span>
			</span>
		);
	}

	return (
		<span className={CELLS.account}>
			<span className="min-w-0 truncate">{connection.account}</span>
			<Badge variant="secondary" className="shrink-0 font-normal tabular-nums">
				+{siblings.length - 1}
			</Badge>
		</span>
	);
}

// The services connected to Personal Agent Proxy. The vault is kept on a page of its own. A
// right click on a row renames or deletes the connection.
export function ConnectionsPage() {
	const {connections: all, agents} = useLoaderData<typeof connectionsLoader>();
	const revalidator = useRevalidator();
	const [pending, setPending] = useState<Pending | null>(null);
	const [error, setError] = useState<string | null>(null);
	const connections = all.filter((connection) => !integrationOf(connection)?.builtIn);
	const connectionsByIntegration = new Map<string, Connection[]>();
	for (const connection of connections) {
		const group = groupOf(connection);
		const siblings = connectionsByIntegration.get(group);
		if (siblings) {
			siblings.push(connection);
			continue;
		}

		connectionsByIntegration.set(group, [connection]);
	}
	const renaming = pending?.action === 'rename' ? pending.connection : null;
	const deleting = pending?.action === 'delete' ? pending.connection : null;

	return (
		<AppShell
			title={<PageTitle detail={`${connections.length} connected`}>Connections</PageTitle>}
			actions={
				<Button size="sm" nativeButton={false} render={<Link to="/connections/new" />}>
					<PlusIcon data-icon="inline-start" />
					Add connection
				</Button>
			}
		>
			<OrgNotice />
			{error && <p className="text-sm text-destructive">{error}</p>}
			<RowList
				header={
					<RowHeader>
						<span className="size-5 shrink-0" />
						<span className="min-w-0 flex-1">Service</span>
						<span className={CELLS.account}>Account</span>
						<span className={CELLS.agents}>Agents</span>
					</RowHeader>
				}
			>
				{connections.length === 0 && <EmptyRows>Nothing connected yet.</EmptyRows>}
				{connections.map((connection) => {
					const integration = integrationOf(connection);
					const siblings = connectionsByIntegration.get(groupOf(connection)) ?? [connection];
					return (
						<Row
							key={connection.id}
							to={`/connections/${connection.id}`}
							tooltip={
								siblings.length > 1 && (
									<span className="flex flex-col items-start gap-0.5">
										{siblings.map((sibling) => (
											<span key={sibling.id}>{sibling.account}</span>
										))}
									</span>
								)
							}
							icon={integration && <IntegrationLogo integration={integration} />}
							title={
								<span className="flex min-w-0 items-baseline gap-2">
									<span className="truncate">{titleOf(connection)}</span>
									{siblings.length > 1 && (
										<Badge variant="secondary" className="shrink-0 font-normal tabular-nums">
											<span className="sm:hidden">{siblings.length}</span>
											<span className="hidden sm:inline">{siblings.length} connections</span>
										</Badge>
									)}
								</span>
							}
							cells={
								<>
									<AccountCell connection={connection} siblings={siblings} />
									<span className={CELLS.agents}>
										{agentsWithAccess(agents, connection).length}
									</span>
								</>
							}
							menu={
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
						const result = await renameConnection(renaming.id, name);
						if (result.isErr()) {
							const said = result.error.kind === 'http' ? apiMessage(result.error.body) : null;
							return said ?? describeFetchError(result.error);
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
					const result = await deleteConnection(deleting.id);
					setError(result.isErr() ? describeFetchError(result.error) : null);
					await revalidator.revalidate();
				}}
			/>
		</AppShell>
	);
}
