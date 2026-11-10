import type {AuditEntry} from '@proxy/contracts/activity';
import type {AgentLogin} from '@proxy/contracts/agents';
import type {Connection} from '@proxy/contracts/connections';
import {RefreshCwIcon} from 'lucide-react';
import type {ComponentProps} from 'react';
import {Link, useRevalidator} from 'react-router';
import {AuditList} from '@/components/audit-list';
import {IconButton} from '@/components/icon-button';

// How many of the latest requests the tab shows; with more, it links to all of them.
const RECENT = 10;

type Props = {
	entries: AuditEntry[];
	agents: AgentLogin[];
	connections: Connection[];
	tasks: ComponentProps<typeof AuditList>['tasks'];
	// The activity log narrowed to what the page is about, for when there is more than fits here.
	allHref: string;
	// What the page is about, which its rows needn't say again.
	of: 'agent' | 'connection';
};

// The Recent activity part of a connection's or an agent's page: its latest requests, as the
// activity log lists them, with a button that loads them again and, with more than it shows, a
// link to all of them.
export function RecentActivity({entries, agents, connections, tasks, allHref, of}: Props) {
	const revalidator = useRevalidator();
	const loading = revalidator.state === 'loading';
	return (
		<div className="flex flex-col gap-2">
			<div className="flex min-h-8 items-center justify-between gap-4 text-sm text-muted-foreground">
				<span>
					{entries.length > RECENT ? (
						<Link to={allHref} className="underline-offset-4 hover:text-foreground hover:underline">
							Go to all activity
						</Link>
					) : (
						`What ${of === 'agent' ? 'it did' : 'agents did with it'}, the latest first`
					)}
				</span>
				<IconButton
					label={loading ? 'Refreshing activity' : 'Refresh activity'}
					size="xs"
					disabled={loading}
					onClick={() => void revalidator.revalidate()}
				>
					<RefreshCwIcon className={loading ? 'motion-safe:animate-spin' : undefined} />
				</IconButton>
			</div>
			<AuditList
				entries={entries.slice(0, RECENT)}
				agents={agents}
				connections={connections}
				tasks={tasks}
				showAgent={of !== 'agent'}
				showConnection={of !== 'connection'}
			/>
		</div>
	);
}
