import {useEffect, useId, useState} from 'react';
import {Link, useLoaderData, useLocation} from 'react-router';
import {getTaskRun} from '@/client/agents-client';
import type {TaskRun} from '@/client/schemas';
import {AppShell, PageTitle} from '@/components/app-shell';
import {AuditEntryDialog} from '@/components/audit-entry-dialog';
import {AuditList} from '@/components/audit-list';
import {BackButton} from '@/components/back-button';
import {AgentLogo} from '@/components/brand-logo';
import {Head} from '@/components/head';
import {type ShownText, TextPanel, TextSwitch} from '@/components/goal-and-outcome';
import {NotFound} from '@/components/not-found';
import {RunTimeline} from '@/components/run-timeline';
import {useOrgSlug} from '@/hooks/use-org';
import {backFrom, backOf} from '@/lib/back';
import {endsOf, STATUS_LABEL, taskStatus} from '@/lib/timeline-window';
import {counted, formatDateTime} from '@/lib/format';
import {formatDuration, outcomeSummary} from '@/lib/timeline';
import type {AgentLogin, AuditEntry, Connection} from '@/lib/types';
import type {taskLoader} from '@/loaders';
import {Badge} from '@proxy/ui/components/badge';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';

// How often a task with any of its tasks under way is read again, so its timeline moves along as
// the agent works.
const REFRESH_MS = 5 * 1000;

// One task of an agent's: when it started, how long it took and, one at a time, what was asked
// for or what came of it, then its run as a timeline, the task and every task handed on from it, at any depth,
// under the one it was handed from, and every request made for any of them, as the activity log
// lists them. Agents work through
// sub-agents, so each task is one of them at work. Read again every few seconds while any of the
// tasks is under way.
export function TaskPage() {
	const org = useOrgSlug();
	const {run, agents, connections} = useLoaderData<typeof taskLoader>();
	if (!run) {
		return <NotFound what="task" back={`/${org}/activity`} backLabel="Back to activity" />;
	}
	// Keyed by the task, so following a link to another task's page starts it afresh, its timeline
	// laid out and its description shown, rather than as the last task's was left.
	return <TaskRunPage key={run.task} initial={run} agents={agents} connections={connections} />;
}

function TaskRunPage({
	initial,
	agents,
	connections,
}: {
	initial: TaskRun;
	agents: AgentLogin[];
	connections: Connection[];
}) {
	const org = useOrgSlug();
	const location = useLocation();
	// The run shown: the first came with the page, and every later reading of it replaces it.
	const [run, setRun] = useState(initial);
	const [opened, setOpened] = useState<AuditEntry | null>(null);
	const [shown, setShown] = useState<ShownText>('goal');
	const textId = useId();
	// Where the page was come to from, where that page said (lib/back.ts): the home page with its
	// window as it was, or the task this one was handed on from; else the activity log, at the task.
	const cameFrom = backOf(location);
	const task = run.tasks.find((candidate) => candidate.id === run.task);
	const running = run.tasks.some(
		(candidate) => taskStatus(candidate, new Date(run.now)) === 'running',
	);

	// Only the run is read again: the connections and agents that name its requests stay as the
	// page found them.
	useEffect(() => {
		if (!running) {
			return;
		}
		let gone = false;
		const timer = setInterval(async () => {
			if (document.visibilityState !== 'visible') {
				return;
			}
			const result = await getTaskRun(org, run.task);
			if (gone || result.isErr()) {
				return;
			}
			setRun(result.value);
		}, REFRESH_MS);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	}, [running, org, run.task]);

	if (!task) {
		return <NotFound what="task" back={`/${org}/activity`} backLabel="Back to activity" />;
	}

	const now = new Date(run.now);
	const status = taskStatus(task, now);
	const agent = agents.find((candidate) => candidate.id === run.agentId);
	const own = run.entries.filter((entry) => entry.taskId === task.id);
	// Left open, it ended no earlier than what it handed on.
	const ended = endsOf(run.tasks, run.entries, now).get(task.id) ?? now;
	const summary = [
		formatDuration(ended.getTime() - new Date(task.startedAt).getTime()),
		counted(own.length, 'request'),
		...outcomeSummary(own),
	];
	return (
		<AppShell
			title={
				<>
					<BackButton
						to={cameFrom?.back ?? `/${org}/activity?task=${encodeURIComponent(task.id)}`}
						state={cameFrom?.then}
						label={cameFrom ? 'Back' : 'Back to activity'}
					/>
					<PageTitle>{task.title}</PageTitle>
				</>
			}
		>
			{/* The page in four blocks, a little further apart than the shell sets them. */}
			<div className="flex flex-col gap-5">
				<div className="flex flex-col gap-2 text-sm">
					<div className="flex items-start justify-between gap-3">
						<div className="flex flex-wrap items-center gap-2">
							<h1 className="text-base font-medium">{task.title}</h1>
							<Badge variant={status === 'running' ? 'outline' : 'secondary'}>
								{STATUS_LABEL[status]}
							</Badge>
						</div>
						<Tooltip>
							<TooltipTrigger
								render={
									<span
										role="img"
										aria-label={task.persona?.name ?? agent?.name ?? 'Deleted agent'}
									/>
								}
							>
								{task.persona ? (
									<Head look={task.persona.look} color={task.persona.color} size={20} />
								) : (
									<AgentLogo providerId={agent?.providerId ?? ''} />
								)}
							</TooltipTrigger>
							<TooltipContent>
								{task.persona?.name ?? agent?.name ?? 'Deleted agent'}
							</TooltipContent>
						</Tooltip>
					</div>
					<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
						<span>Started {formatDateTime(task.startedAt)}</span>
						{summary.map((part) => (
							<span key={part} className="contents">
								<span aria-hidden>·</span>
								<span>{part}</span>
							</span>
						))}
						{run.parent && (
							<>
								<span aria-hidden>·</span>
								<span>
									Handed on from{' '}
									<Link
										to={`/${org}/activity/tasks/${encodeURIComponent(run.parent.id)}`}
										state={backFrom(location)}
										className="text-foreground hover:underline"
									>
										{run.parent.title}
									</Link>
								</span>
							</>
						)}
					</p>
					<TextSwitch
						id={textId}
						shown={shown}
						hasOutcome={task.outcome !== null}
						onChange={setShown}
					/>
				</div>
				<TextPanel
					id={textId}
					shown={shown}
					goal={task.goal}
					outcome={task.outcome}
					className="text-sm"
				/>
				<RunTimeline
					tasks={run.tasks}
					entries={run.entries}
					now={run.now}
					connections={connections}
					onOpenEntry={setOpened}
				/>
				<AuditList
					entries={[...run.entries].reverse()}
					agents={agents}
					connections={connections}
					tasks={run.tasks}
					showAgent={false}
				/>
			</div>
			<AuditEntryDialog
				entry={opened}
				agents={agents}
				connections={connections}
				tasks={run.tasks}
				onClose={() => setOpened(null)}
			/>
		</AppShell>
	);
}
