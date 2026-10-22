import {useState} from 'react';
import {AuditEntryDialog} from '@/components/audit-entry-dialog';
import {EmptyRows, RowHeader, RowList} from '@/components/row-list';
import {AgentLogo, IntegrationLogo, ProxyLogo} from '@/components/brand-logo';
import {connectionLabel, describeEntry, locateEntry} from '@/lib/access';
import {formatDateTime} from '@/lib/format';
import type {ActivityTask, AgentLogin, AuditEntry, Connection} from '@/lib/types';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';
import type {ReactNode} from 'react';

const CELLS = {
	at: 'w-32 shrink-0 whitespace-nowrap text-muted-foreground tabular-nums',
	logo: 'flex w-5 shrink-0',
};

// A logo standing for an agent or a connection, named in its tooltip. One that is gone has an
// empty tile.
function NamedLogo({name, logo}: {name: string; logo: ReactNode}) {
	return (
		<Tooltip>
			<TooltipTrigger render={<span role="img" aria-label={name} className={CELLS.logo} />}>
				{logo ?? <span className="size-5 rounded-md border border-dashed" />}
			</TooltipTrigger>
			<TooltipContent>{name}</TooltipContent>
		</Tooltip>
	);
}

// The agent an entry was made by, or Personal Agent Proxy for what it did itself, with who asked.
function EntryAgentLogo({entry, agent}: {entry: AuditEntry; agent: AgentLogin | undefined}) {
	if (entry.agentId === null) {
		return <NamedLogo name={`Personal Agent Proxy${askedBy(entry)}`} logo={<ProxyLogo />} />;
	}

	return (
		<NamedLogo
			name={agent?.name ?? 'Deleted agent'}
			logo={agent && <AgentLogo providerId={agent.providerId} />}
		/>
	);
}

// " for Dana": who asked for what Personal Agent Proxy did itself; nothing for an agent's request.
function askedBy(entry: AuditEntry): string {
	if (entry.userId === null) {
		return '';
	}
	return ` for ${entry.userName ?? 'a former member'}`;
}

type Props = {
	entries: AuditEntry[];
	// To name each entry's agent and connection, while they still exist, and the task it was for.
	agents: AgentLogin[];
	connections: Connection[];
	tasks: ActivityTask[];
	// Left out where the page is about one agent or one connection already.
	showAgent?: boolean;
	showConnection?: boolean;
};

// The audit log's lines: when, which agent, what it did, for which task, and where, the agent and
// the connection each a logo with its name in a tooltip. Denied requests read in red; those that
// came in over MCP say so. What Personal Agent Proxy did itself, as the home page's widgets write,
// reads as its own. A row opens the entry in full.
export function AuditList({
	entries,
	agents,
	connections,
	tasks,
	showAgent = true,
	showConnection = true,
}: Props) {
	const [opened, setOpened] = useState<AuditEntry | null>(null);

	return (
		<>
			<RowList
				header={
					<RowHeader>
						<span className={CELLS.at}>Time</span>
						{showAgent && <span className={CELLS.logo} />}
						<span className="min-w-0 flex-1">Request</span>
						{showConnection && <span className={CELLS.logo} />}
					</RowHeader>
				}
			>
				{entries.length === 0 && <EmptyRows>No activity yet.</EmptyRows>}
				{entries.map((entry) => {
					const agent = agents.find((candidate) => candidate.id === entry.agentId);
					const located = locateEntry(connections, entry);
					const integration = located?.integration ?? null;
					const refusedOrFailed = entry.outcome !== 'allowed';
					const task = tasks.find((candidate) => candidate.id === entry.taskId);
					return (
						<li key={entry.id} className="-mx-(--bleed)">
							<button
								type="button"
								onClick={() => setOpened(entry)}
								className="flex h-10 w-full items-center gap-3 px-(--bleed) text-left text-sm hover:bg-muted/50 active:bg-muted/50"
							>
								<span className={CELLS.at}>{formatDateTime(entry.at)}</span>
								{showAgent && <EntryAgentLogo entry={entry} agent={agent} />}
								<span
									className={cn('min-w-0 flex-1 truncate', refusedOrFailed && 'text-destructive')}
								>
									{describeEntry(entry, located)}
									{task && <span className="text-muted-foreground"> · for {task.title}</span>}
									{entry.via === 'mcp' && (
										<span className="text-muted-foreground"> · over MCP</span>
									)}
								</span>
								{showConnection && (
									<NamedLogo
										name={
											located ? connectionLabel(connections, located.connection) : 'Disconnected'
										}
										logo={integration && <IntegrationLogo integration={integration} />}
									/>
								)}
							</button>
						</li>
					);
				})}
			</RowList>
			<AuditEntryDialog
				entry={opened}
				agents={agents}
				connections={connections}
				tasks={tasks}
				onClose={() => setOpened(null)}
			/>
		</>
	);
}
