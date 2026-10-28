import {Link} from 'react-router';
import {Badge} from '@proxy/ui/components/badge';
import {cn} from '@proxy/ui/lib/utils';
import type {InspectedJob, InspectedThread} from '@/client/inspect-client';
import {useOrgSlug} from '@/hooks/use-org';
import {formatTime} from '@/lib/format';
import {
	formatDue,
	formatDuration,
	jobTitle,
	lastAttempt,
	threadLabel,
	threadStatus,
	type ThreadStatus,
	tokensOf,
} from '@/lib/inspect';

// The inspector's left column: the conversation's threads, the conversation first and the
// sub-agents started from it under it, each with where it stands; and under them the queue,
// every job of every thread still to run or running, with its history behind a toggle.

const STATUS_LABEL: Record<ThreadStatus['kind'], string> = {
	working: 'working',
	queued: 'queued',
	asleep: 'asleep',
	waiting: 'waiting',
	reported: 'reported',
	failed: 'failed',
};

const STATUS_CLASS: Record<ThreadStatus['kind'], string> = {
	working: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
	queued: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
	asleep: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
	waiting: 'bg-muted text-muted-foreground',
	reported: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
	failed: 'bg-destructive/10 text-destructive',
};

export function StatusBadge({status}: {status: ThreadStatus}) {
	return (
		<Badge variant="outline" className={cn('border-transparent', STATUS_CLASS[status.kind])}>
			{STATUS_LABEL[status.kind]}
			{status.until !== null && ` until ${formatTime(status.until)}`}
		</Badge>
	);
}

function ThreadRow({
	thread,
	now,
	current,
	onSelect,
}: {
	thread: InspectedThread;
	now: string;
	current: boolean;
	onSelect: (threadId: string) => void;
}) {
	const org = useOrgSlug();
	const tokens = tokensOf(thread.entries);
	const sub = thread.parentThreadId !== null;
	return (
		<li className={cn('flex flex-col gap-0.5', sub && 'pl-3')}>
			<button
				type="button"
				onClick={() => onSelect(thread.id)}
				aria-current={current ? 'true' : undefined}
				className={cn(
					'flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-muted',
					sub && 'border-l',
					current && 'bg-muted',
				)}
			>
				<span className="flex items-center gap-2">
					<span className="min-w-0 flex-1 truncate text-sm font-medium">{threadLabel(thread)}</span>
					<StatusBadge status={threadStatus(thread, now)} />
				</span>
				<span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
					<span>{thread.entries.length} entries</span>
					<span>
						{tokens.input.toLocaleString('en-US')} in / {tokens.output.toLocaleString('en-US')} out
					</span>
					{thread.state.pendingCalls.length > 0 && (
						<span>{thread.state.pendingCalls.length} open calls</span>
					)}
				</span>
			</button>
			{thread.taskId !== null && (
				<Link
					to={`/${org}/activity/tasks/${thread.taskId}`}
					className="px-2 text-xs text-muted-foreground underline-offset-4 hover:underline"
				>
					Task in the activity log
				</Link>
			)}
		</li>
	);
}

export function ThreadTree({
	threads,
	now,
	current,
	onSelect,
}: {
	threads: InspectedThread[];
	now: string;
	current: string;
	onSelect: (threadId: string) => void;
}) {
	return (
		<section aria-label="Threads" className="p-2">
			<h2 className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
				Threads
			</h2>
			<ul className="flex flex-col gap-0.5">
				{threads.map((thread) => (
					<ThreadRow
						key={thread.id}
						thread={thread}
						now={now}
						current={thread.id === current}
						onSelect={onSelect}
					/>
				))}
			</ul>
		</section>
	);
}

const JOB_CLASS: Record<InspectedJob['status'], string> = {
	running: STATUS_CLASS.working,
	queued: STATUS_CLASS.queued,
	done: STATUS_CLASS.reported,
	failed: STATUS_CLASS.failed,
};

// Running first, then queued by when they are due, then what is over, newest first.
function order(a: InspectedJob, b: InspectedJob): number {
	const rank = (job: InspectedJob) =>
		job.status === 'running' ? 0 : job.status === 'queued' ? 1 : 2;
	if (rank(a) !== rank(b)) {
		return rank(a) - rank(b);
	}
	if (a.status === 'queued') {
		return a.runAt.localeCompare(b.runAt);
	}
	return b.createdAt.localeCompare(a.createdAt);
}

// What a job is up to, in a line: due when, held by whom until when, or how long it ran.
function jobDetail(job: InspectedJob, thread: InspectedThread, now: string): string {
	if (job.status === 'queued') {
		return `${formatDue(job.runAt, now)}${job.attempts > 0 ? `, attempt ${job.attempts + 1}` : ''}`;
	}
	const attempt = lastAttempt(job, thread.events);
	if (job.status === 'running') {
		const lease =
			job.leaseExpiresAt === null
				? ''
				: `, lease ${formatDue(job.leaseExpiresAt, now).replace('in ', '')} left`;
		const since =
			attempt.claimedAt === null
				? ''
				: `, ${formatDuration(new Date(now).getTime() - new Date(attempt.claimedAt).getTime())} so far`;
		return `${job.claimedBy ?? 'claimed'}${lease}${since}, attempt ${job.attempts}`;
	}
	const ran = attempt.ranMs === null ? '' : `ran ${formatDuration(attempt.ranMs)}, `;
	return `${ran}${job.attempts} ${job.attempts === 1 ? 'attempt' : 'attempts'}`;
}

function JobRow({
	job,
	thread,
	now,
	onSelectThread,
}: {
	job: InspectedJob;
	thread: InspectedThread;
	now: string;
	onSelectThread: (threadId: string) => void;
}) {
	return (
		<li className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-xs">
			<span className="flex items-center gap-2">
				<Badge variant="outline" className={cn('border-transparent', JOB_CLASS[job.status])}>
					{job.status}
				</Badge>
				<span className="font-mono font-medium">{jobTitle(job, thread.entries)}</span>
				<button
					type="button"
					onClick={() => onSelectThread(thread.id)}
					className="min-w-0 flex-1 truncate text-left text-muted-foreground underline-offset-4 hover:underline"
				>
					{threadLabel(thread)}
				</button>
			</span>
			<span className="text-muted-foreground">{jobDetail(job, thread, now)}</span>
			{job.error !== null && <span className="text-destructive">{job.error}</span>}
		</li>
	);
}

export function JobQueue({
	threads,
	now,
	showHistory,
	onToggleHistory,
	onSelectThread,
}: {
	threads: InspectedThread[];
	now: string;
	showHistory: boolean;
	onToggleHistory: () => void;
	onSelectThread: (threadId: string) => void;
}) {
	const jobs = threads
		.flatMap((thread) => thread.jobs.map((job) => ({job, thread})))
		.filter(({job}) => showHistory || job.status === 'queued' || job.status === 'running')
		.sort((a, b) => order(a.job, b.job));
	return (
		<section aria-label="Jobs" className="border-t p-2">
			<h2 className="flex items-center px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
				<span className="flex-1">Jobs</span>
				<button
					type="button"
					onClick={onToggleHistory}
					className="font-normal normal-case underline-offset-4 hover:underline"
				>
					{showHistory ? 'Open only' : 'With history'}
				</button>
			</h2>
			{jobs.length === 0 && (
				<p className="px-2 py-1 text-xs text-muted-foreground">Nothing queued or running.</p>
			)}
			<ul className="flex flex-col gap-0.5">
				{jobs.map(({job, thread}) => (
					<JobRow
						key={job.id}
						job={job}
						thread={thread}
						now={now}
						onSelectThread={onSelectThread}
					/>
				))}
			</ul>
		</section>
	);
}
