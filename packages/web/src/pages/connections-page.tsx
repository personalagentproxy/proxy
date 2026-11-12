import type {Member} from '@proxy/contracts/orgs';
import {Tooltip, TooltipTrigger, TooltipContent} from '@proxy/ui/components/tooltip';
import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {ForwardIcon, PencilIcon, Trash2Icon} from 'lucide-react';
import {useState, type ReactNode} from 'react';
import {Link, useSearchParams} from 'react-router';
import {PersonAvatar} from '@/components/person-avatar';
import {PersonHeads} from '@/components/person-heads';
import {deleteConnection, moveConnection, renameConnection} from '@/client/connections-client';
import {AppShell, PageHeader, PageTitle} from '@/components/app-shell';
import {AddButton} from '@/components/add-button';
import {IntegrationLogo} from '@/components/brand-logo';
import {ConfirmDialog} from '@/components/confirm-dialog';
import {MoveConnectionDialog} from '@/components/move-connection-dialog';
import {OrgNotice} from '@/components/org-notice';
import {RenameDialog} from '@/components/rename-dialog';
import {Row, RowHeader, RowList} from '@/components/row-list';
import {ContextMenuItem} from '@proxy/ui/components/context-menu';
import {useHuman} from '@/hooks/use-human';
import {useLoaded} from '@/hooks/use-loaded';
import {useReload} from '@/hooks/use-reload';
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
	connectedBy: 'hidden w-48 shrink-0 truncate text-muted-foreground md:flex md:items-center',
	sharedWith: 'hidden w-32 shrink-0 md:flex',
	agents: 'w-20 shrink-0 text-muted-foreground tabular-nums',
};

type SortColumn = 'service' | 'connectedBy' | 'audience' | 'agents';
type Sort = {column: SortColumn; direction: 'asc' | 'desc'};

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

function sortValue(
	column: SortColumn,
	connection: Connection,
	agents: AgentLogin[],
): string | number {
	if (column === 'service') {
		return connectionTitle(connection);
	}
	if (column === 'connectedBy') {
		return ownerOfConnection(connection, []).name ?? '';
	}
	if (column === 'audience') {
		return [
			connection.sharedWithEveryone ? 'Entire company' : '',
			...sharedWithPeople(connection, []).map((person) => person.name ?? person.email),
		]
			.filter((value) => value.length > 0)
			.join(', ');
	}
	return agentsWithAccess(agents, connection).length;
}

function SortHeader({
	label,
	column,
	sort,
	onClick,
	className,
}: {
	label: string;
	column: SortColumn;
	sort: Sort;
	onClick: (column: SortColumn) => void;
	className?: string;
}) {
	const selected = sort.column === column;
	return (
		<span
			role="columnheader"
			aria-sort={selected ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
			className={className}
		>
			<button
				type="button"
				className="truncate text-left hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
				onClick={() => onClick(column)}
			>
				{label}
				{selected ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
			</button>
		</span>
	);
}

// Every connection is shown by default. The people at the top filter connections to which each
// person has access; the row shows who connected it and who can use it.
export function ConnectionsPage() {
	return (
		<AppShell loadsTitle>
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
	const [params, setParams] = useSearchParams();
	const memberId = params.get('member');
	const [sort, setSort] = useState<Sort>({column: 'service', direction: 'asc'});
	const matches = (connection: Connection) =>
		!memberId ||
		connection.sharedWithEveryone ||
		connection.ownerUserId === memberId ||
		connection.sharedWith.some((person) => person.userId === memberId);
	if (!human) {
		return null;
	}
	const activeOrg = human.org;
	const connections = all.filter(matches).sort((first, second) => {
		const firstValue = sortValue(sort.column, first, agents);
		const secondValue = sortValue(sort.column, second, agents);
		const comparison =
			typeof firstValue === 'number' && typeof secondValue === 'number'
				? firstValue - secondValue
				: String(firstValue).localeCompare(String(secondValue), undefined, {sensitivity: 'base'});
		return (
			(sort.direction === 'asc' ? comparison : -comparison) || first.id.localeCompare(second.id)
		);
	});
	const sortBy = (column: SortColumn) => {
		setSort((current) => ({
			column,
			direction: current.column === column && current.direction === 'asc' ? 'desc' : 'asc',
		}));
	};
	const renaming = pending?.action === 'rename' ? pending.connection : null;
	const moving = pending?.action === 'move' ? pending.connection : null;
	const deleting = pending?.action === 'delete' ? pending.connection : null;
	// Where the person's own connections can move: their other organizations.
	const otherOrgs = human.orgs.filter((other) => other.id !== activeOrg.id);

	return (
		<>
			<PageHeader
				title={<PageTitle detail={`${connections.length} shown`}>Connections</PageTitle>}
				actions={<AddButton label="Add connection" to={`/${org}/connections/new`} />}
			/>
			<OrgNotice />
			<div className="flex flex-wrap items-center gap-2">
				<div
					className="flex items-center gap-2"
					role="group"
					aria-label="Filter connections by person"
				>
					<PersonFilter
						selected={!memberId}
						label="All people"
						onSelect={() => {
							const next = new URLSearchParams(params);
							next.delete('member');
							setParams(next, {replace: true});
						}}
					>
						<img src="/ontora-mark.png" alt="" className="size-7 rounded-full" />
					</PersonFilter>
					{members.map((person) => (
						<PersonFilter
							key={person.userId}
							selected={memberId === person.userId}
							label={`${person.name ?? person.email}${person.userId === human.user.id ? ' (you)' : ''}`}
							onSelect={() => {
								const next = new URLSearchParams(params);
								next.set('member', person.userId);
								setParams(next, {replace: true});
							}}
						>
							<PersonAvatar person={person} className="size-7" />
						</PersonFilter>
					))}
				</div>
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<RowList
				header={
					<RowHeader>
						<span className="size-5 shrink-0" />
						<SortHeader
							label="Service"
							column="service"
							sort={sort}
							onClick={sortBy}
							className="min-w-0 flex-1"
						/>
						<SortHeader
							label="Connected by"
							column="connectedBy"
							sort={sort}
							onClick={sortBy}
							className={CELLS.connectedBy}
						/>
						<SortHeader
							label="People with access"
							column="audience"
							sort={sort}
							onClick={sortBy}
							className={CELLS.sharedWith}
						/>
						<SortHeader
							label="Agents"
							column="agents"
							sort={sort}
							onClick={sortBy}
							className={CELLS.agents}
						/>
						<span className="w-24 shrink-0" />
					</RowHeader>
				}
			>
				{connections.length === 0 && (
					<li className="py-3 text-sm text-muted-foreground">No connections match this filter.</li>
				)}
				{connections.map((connection) => {
					const integration = integrationOf(connection);
					return (
						<Row
							key={connection.id}
							to={`/${org}/connections/${connection.id}`}
							icon={integration && <IntegrationLogo integration={integration} />}
							title={connectionTitle(connection)}
							after={
								<Link
									to={`/${org}/connections/${connection.id}?tab=sharing`}
									aria-label={`${manages(human, connection) ? 'Share' : 'View sharing for'} ${connectionTitle(connection)}`}
									className="w-24 text-center text-sm font-medium"
								>
									{manages(human, connection) ? 'Share' : 'View sharing'}
								</Link>
							}
							cells={
								<>
									<ConnectionOwner connection={connection} members={members} />
									<span className={CELLS.sharedWith}>
										<ConnectionAudience connection={connection} members={members} />
									</span>
									<span className={CELLS.agents}>
										<AgentAccess agents={agentsWithAccess(agents, connection)} />
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

function PersonFilter({
	selected,
	label,
	onSelect,
	children,
}: {
	selected: boolean;
	label: string;
	onSelect: () => void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={label}
						aria-pressed={selected}
						className={`rounded-full ring-2 ${selected ? 'ring-primary' : 'ring-transparent hover:ring-muted-foreground/40'}`}
						onClick={onSelect}
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function ConnectionOwner({connection, members}: {connection: Connection; members: Member[]}) {
	const owner = ownerOfConnection(connection, members);
	return (
		<span className={CELLS.connectedBy}>
			<PersonAvatar person={owner} className="size-6" />
			<span className="ml-2 truncate">{owner.name ?? owner.email}</span>
		</span>
	);
}

function ConnectionAudience({connection, members}: {connection: Connection; members: Member[]}) {
	const owner = ownerOfConnection(connection, members);
	const people = [owner, ...sharedWithPeople(connection, members)];
	const names = people
		.map((person) => person.name ?? person.email)
		.filter(Boolean)
		.join(', ');
	const label = `${connection.sharedWithEveryone ? 'Entire company: ' : ''}${names}`;
	return (
		<span role="group" aria-label={`People with access: ${label}`}>
			<PersonHeads people={people} />
		</span>
	);
}

function AgentAccess({agents}: {agents: AgentLogin[]}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={<span tabIndex={0} role="img" aria-label={`${agents.length} agents with access`} />}
			>
				{agents.length}
			</TooltipTrigger>
			<TooltipContent>
				{agents.length === 0 ? (
					<span>No agents have access</span>
				) : (
					<span className="flex flex-col gap-2">
						{agents.map((agent) => (
							<span key={agent.id} className="flex items-center gap-2">
								{agent.name}
							</span>
						))}
					</span>
				)}
			</TooltipContent>
		</Tooltip>
	);
}
