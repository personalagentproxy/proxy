import {useStore} from '@/components/mock-store';
import {EmptyRows, RowHeader, RowList} from '@/components/row-list';
import {describeEntry, locate} from '@/lib/access';
import {formatDateTime} from '@/lib/format';
import type {AuditEntry} from '@/lib/types';
import {cn} from '@/lib/utils';

const CELLS = {
	at: 'w-28 shrink-0 text-muted-foreground tabular-nums',
	agent: 'hidden w-36 shrink-0 truncate md:block',
	connection: 'hidden w-36 shrink-0 truncate text-right text-muted-foreground md:block',
};

type Props = {
	entries: AuditEntry[];
	// Left out where the page is about one agent or one connection already.
	showAgent?: boolean;
	showConnection?: boolean;
};

// The audit log's lines: when, which agent, what it did, and where. Denied requests read in red.
export function AuditList({entries, showAgent = true, showConnection = true}: Props) {
	const {state} = useStore();

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
				const agent = state.agents.find((candidate) => candidate.id === entry.agentId);
				const located = locate(state, entry.connectionId, entry.collectionId);
				const denied = entry.outcome === 'denied';
				return (
					<li key={entry.id} className="flex h-10 items-center gap-3 px-4 text-sm md:px-3">
						<span className={CELLS.at}>{formatDateTime(entry.at)}</span>
						{showAgent && <span className={CELLS.agent}>{agent?.name ?? 'Deleted agent'}</span>}
						<span className={cn('min-w-0 flex-1 truncate', denied && 'text-destructive')}>
							{describeEntry(entry, located?.collection)}
						</span>
						{showConnection && (
							<span className={CELLS.connection}>
								{located?.integration.name ?? 'Disconnected'}
							</span>
						)}
					</li>
				);
			})}
		</RowList>
	);
}
