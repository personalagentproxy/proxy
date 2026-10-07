import {EmptyRows, RowHeader, RowList} from '@/components/row-list';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {connectionLabel, describeEntry, integrationOf, locateEntry} from '@/lib/access';
import {formatDateTime} from '@/lib/format';
import type {AgentLogin, AuditEntry, Connection} from '@/lib/types';
import {cn} from '@proxy/ui/lib/utils';

const CELLS = {
	at: 'w-28 shrink-0 text-muted-foreground tabular-nums',
	agent: 'hidden w-36 shrink-0 truncate md:block',
	connection: 'hidden w-36 shrink-0 truncate text-right text-muted-foreground md:block',
};

type Props = {
	entries: AuditEntry[];
	// To name each entry's agent and connection, while they still exist.
	agents: AgentLogin[];
	connections: Connection[];
	// Left out where the page is about one agent or one connection already.
	showAgent?: boolean;
	showConnection?: boolean;
};

// The audit log's lines: when, which agent, what it did, and where. Denied requests read in red.
export function AuditList({
	entries,
	agents,
	connections,
	showAgent = true,
	showConnection = true,
}: Props) {
	return (
		<RowList
			header={
				<RowHeader>
					<span className={CELLS.at}>Time</span>
					{showAgent && <span className={CELLS.agent}>Agent</span>}
					<span className="min-w-0 flex-1">Request</span>
					{showConnection && <span className={CELLS.connection}>Connection</span>}
				</RowHeader>
			}
		>
			{entries.length === 0 && <EmptyRows>No activity yet.</EmptyRows>}
			{entries.map((entry) => {
				const agent = agents.find((candidate) => candidate.id === entry.agentId);
				const located = locateEntry(connections, entry);
				const integration = located ? integrationOf(located.connection) : null;
				const denied = entry.outcome === 'denied';
				return (
					<li key={entry.id} className="flex h-10 items-center gap-3 px-4 text-sm md:px-3">
						<span className={CELLS.at}>{formatDateTime(entry.at)}</span>
						{showAgent && (
							<span className={CELLS.agent}>
								<span className="flex items-center gap-2">
									<AgentLogo providerId={agent?.providerId ?? null} />
									<span className="truncate">{agent?.name ?? 'Deleted agent'}</span>
								</span>
							</span>
						)}
						<span className={cn('min-w-0 flex-1 truncate', denied && 'text-destructive')}>
							{describeEntry(entry, located?.collection)}
						</span>
						{showConnection && (
							<span className={CELLS.connection}>
								<span className="flex items-center justify-end gap-2">
									{integration && <IntegrationLogo integration={integration} />}
									<span className="truncate">
										{located ? connectionLabel(connections, located.connection) : 'Disconnected'}
									</span>
								</span>
							</span>
						)}
					</li>
				);
			})}
		</RowList>
	);
}
