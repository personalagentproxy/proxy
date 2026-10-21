import {TOOLS_COLLECTION_ID} from '@proxy/integrations';
import type {ReactNode} from 'react';
import {Link} from 'react-router';
import {Badge} from '@proxy/ui/components/badge';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {AgentLogo, IntegrationLogo, ProxyLogo} from '@/components/brand-logo';
import {describeEntry, entryAction, locateEntry} from '@/lib/access';
import type {ActivityTask, AgentLogin, AuditEntry, Connection} from '@/lib/types';

type Props = {
	// The entry shown, or null while the dialog is closed.
	entry: AuditEntry | null;
	agents: AgentLogin[];
	connections: Connection[];
	// To name the task the entry was made for.
	tasks: ActivityTask[];
	onClose: () => void;
};

// "Wednesday, October 14, 2026 at 11:15:32 PM": the moment to the second.
function formatMoment(iso: string): string {
	return new Date(iso).toLocaleString('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	});
}

function Detail({label, children}: {label: string; children: ReactNode}) {
	return (
		<div className="flex gap-3 py-2">
			<dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
			<dd className="flex min-w-0 flex-1 items-center gap-2">{children}</dd>
		</div>
	);
}

// One activity log entry in full: who, what, for which task, where, when, and the permission it
// needed, with links to the agent and the connection while they still exist, and to the task's
// other requests.
export function AuditEntryDialog({entry, agents, connections, tasks, onClose}: Props) {
	return (
		<Dialog
			open={entry !== null}
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				onClose();
			}}
		>
			{entry && (
				<AuditEntryContent entry={entry} agents={agents} connections={connections} tasks={tasks} />
			)}
		</Dialog>
	);
}

function AuditEntryContent({
	entry,
	agents,
	connections,
	tasks,
}: {
	entry: AuditEntry;
	agents: AgentLogin[];
	connections: Connection[];
	tasks: ActivityTask[];
}) {
	const agent = agents.find((candidate) => candidate.id === entry.agentId);
	const task = tasks.find((candidate) => candidate.id === entry.taskId);
	const located = locateEntry(connections, entry);
	const action = entryAction(entry, located);
	const denied = entry.outcome === 'denied';
	const toolRun = located?.integration.custom || entry.collectionId === TOOLS_COLLECTION_ID;

	return (
		<DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-lg">
			<DialogHeader>
				<DialogTitle className="pr-8 leading-snug break-words">
					{describeEntry(entry, located)}
				</DialogTitle>
				<DialogDescription>{formatMoment(entry.at)}</DialogDescription>
			</DialogHeader>
			<dl className="divide-y text-sm">
				<Detail label="Outcome">
					{denied ? (
						<Badge variant="destructive">Denied</Badge>
					) : (
						<Badge variant="secondary">Allowed</Badge>
					)}
				</Detail>
				<Detail label="Agent">
					{entry.agentId === null && (
						<>
							<ProxyLogo />
							<span className="min-w-0 truncate">Personal Agent Proxy</span>
						</>
					)}
					{entry.agentId !== null && agent && (
						<>
							<AgentLogo providerId={agent.providerId} />
							<Link to={`/agents/${agent.id}`} className="min-w-0 truncate hover:underline">
								{agent.name}
							</Link>
						</>
					)}
					{entry.agentId !== null && !agent && (
						<span className="text-muted-foreground">Deleted agent</span>
					)}
				</Detail>
				{entry.taskId !== null && (
					<Detail label="Task">
						{task ? (
							<span className="flex min-w-0 flex-col gap-0.5">
								<Link
									to={`/activity?task=${encodeURIComponent(task.id)}`}
									className="min-w-0 break-words hover:underline"
								>
									{task.title}
								</Link>
								<span className="min-w-0 text-muted-foreground break-words">{task.goal}</span>
							</span>
						) : (
							<span className="text-muted-foreground">Unknown task</span>
						)}
					</Detail>
				)}
				<Detail label="Connection">
					{located ? (
						<>
							<IntegrationLogo integration={located.integration} />
							<Link
								to={`/connections/${located.connection.id}`}
								className="max-w-1/2 shrink-0 truncate hover:underline"
							>
								{located.connection.name ?? located.integration.name}
							</Link>
							<span className="min-w-0 truncate text-muted-foreground">
								{located.connection.account}
							</span>
						</>
					) : (
						<span className="text-muted-foreground">Disconnected</span>
					)}
				</Detail>
				{!toolRun && (
					<Detail label="Collection">{located?.collection?.name ?? entry.collectionId}</Detail>
				)}
				{entry.recordTitle && (
					<Detail label={entry.action === 'list' ? 'Inside' : 'Record'}>
						<span className="min-w-0 break-words">{entry.recordTitle}</span>
					</Detail>
				)}
				{entry.query && (
					<Detail label={toolRun ? 'Params' : 'Search'}>
						<span
							className={toolRun ? 'min-w-0 font-mono text-xs break-all' : 'min-w-0 break-words'}
						>
							{entry.query}
						</span>
					</Detail>
				)}
				<Detail label="Permission">
					{action ? action.label : <span className="text-muted-foreground">Unknown</span>}
				</Detail>
				<Detail label="Through">{entry.via === 'mcp' ? 'MCP' : 'Agent web pages'}</Detail>
			</dl>
		</DialogContent>
	);
}
