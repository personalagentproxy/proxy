import {ChevronDownIcon, ChevronRightIcon, CornerDownRightIcon} from 'lucide-react';
import {Fragment, useId, useMemo, useState} from 'react';
import {Link, useLocation} from 'react-router';
import {
	AxisLabels,
	ChartLegend,
	ChartTarget,
	HatchDefs,
	Shimmer,
	RequestMarks,
	RequestTargets,
	RequestTooltip,
	TasksTooltip,
	TaskTooltip,
	Track,
} from '@/components/timeline-chart';
import {useRequestTooltip} from '@/hooks/use-request-tooltip';
import {useTitleOf} from '@/hooks/use-title-of';
import {useChartWidth} from '@/hooks/use-chart-width';
import {useOrgSlug} from '@/hooks/use-org';
import {backFrom} from '@/lib/back';
import {formatTime} from '@/lib/format';
import {
	buildRunTimeline,
	defaultExpanded,
	folded,
	type RunBreak,
	type RunRow,
	type RunTimeline as RunLayout,
} from '@/lib/run-timeline';
import {
	ABANDONED_OPACITY,
	formatDuration,
	MIN_TRACK_PX,
	roughDuration,
	TASK_COLOR_CLASS,
} from '@/lib/timeline';
import type {ActivityTask, AuditEntry, Connection} from '@/lib/types';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';

// A row's height and its track's, in pixels; the lines between rows are placed by them.
const ROW_H = 30;
const TRACK_H = 14;
const TRACK_TOP = (ROW_H - TRACK_H) / 2;

// How far a line between rows runs beside a track before it turns into it: its corner's radius.
const ELBOW = 8;

const LABEL = 'w-44 shrink-0 md:w-64';

type Props = {
	tasks: ActivityTask[];
	entries: AuditEntry[];
	// When the answer was read: where a task under way has got to.
	now: string;
	// The task the page is about, which stands out.
	connections: Connection[];
	onOpenEntry: (entry: AuditEntry) => void;
};

// A task's run (the layout in lib/run-timeline.ts): the task in the top row and every task handed
// on from it in a row under the task it was handed from, along one axis from when the task
// started to the last thing done, its idle stretches folded away. A track runs as long as its task did, the requests made
// for it solid on it, hatched where it waited on what it handed on; a line goes down from a task
// where it handed one on and back up where that one was finished, standing out for the row under
// the pointer. A task's sub-tasks are laid out under it or rolled into it by its chevron, and
// short tasks one after another sit in one row until theirs is opened. Every mark says more on
// hover; a request opens in full, a sub-task's name opens its page.
export function RunTimeline({tasks, entries, now, connections, onOpenEntry}: Props) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => defaultExpanded(tasks));
	const [active, setActive] = useState<string | null>(null);
	const [measure, width] = useChartWidth();
	const hatch = useId();
	const requestTooltip = useRequestTooltip();
	// Laid out again only where what it shows changes, not as the pointer moves over it.
	const timeline = useMemo(
		() => buildRunTimeline(tasks, entries, new Date(now), width, {expanded}),
		[tasks, entries, now, width, expanded],
	);
	const titleOf = useTitleOf(tasks);
	// Folding a task folds the groups under it back together too.
	const toggle = (row: RunRow) =>
		setExpanded((current) => {
			if (current.has(row.id)) {
				return folded(current, tasks, row.id);
			}
			return new Set([...current, row.id]);
		});
	const isOpen = (row: RunRow, index: number) =>
		row.kind === 'task' && timeline.rows.some((candidate) => candidate.parentRow === index);
	const isActive = (row: RunRow) =>
		row.id === active || (row.parentRow !== null && timeline.rows[row.parentRow]?.id === active);
	const height = Math.max(timeline.rows.length, 1) * ROW_H;

	return (
		<div className="flex flex-col gap-2 text-sm">
			<div className="flex overflow-hidden rounded-lg border">
				<div className={cn(LABEL, 'min-w-0 border-r bg-muted/40')}>
					{timeline.rows.map((row, index) => (
						<RowLabel
							key={row.id}
							row={row}
							open={isOpen(row, index)}
							active={isActive(row)}
							onToggle={() => toggle(row)}
							onHover={(over) => setActive(over ? row.id : null)}
						/>
					))}
					<div className="h-7" />
				</div>
				<div className="min-w-0 flex-1 px-4">
					<div ref={measure} className="relative" style={{height}}>
						<svg width={width} height={height} className="absolute inset-0 block overflow-hidden">
							<HatchDefs id={hatch} />
							{timeline.ticks.map((tick) => (
								<line
									key={tick.px}
									x1={tick.px}
									x2={tick.px}
									y1={0}
									y2={height}
									className="stroke-border/70"
								/>
							))}
							{timeline.breaks.map((gap) => (
								<Fragment key={gap.start}>
									<rect
										x={gap.start}
										y={0}
										width={gap.end - gap.start}
										height={height}
										className="fill-muted-foreground/8"
									/>
									<rect
										x={gap.start}
										y={0}
										width={gap.end - gap.start}
										height={height}
										fill={`url(#${hatch})`}
										opacity={0.4}
									/>
								</Fragment>
							))}
							{timeline.rows.map((row, index) => (
								<g
									key={row.id}
									className={TASK_COLOR_CLASS}
									transform={`translate(0 ${index * ROW_H})`}
								>
									{isActive(row) && (
										<rect x={0} y={0} width={width} height={ROW_H} className="fill-foreground/4" />
									)}
									{row.kind === 'group' && (
										<Track
											span={row}
											y={TRACK_TOP}
											height={TRACK_H}
											opacity={row.status === 'abandoned' ? ABANDONED_OPACITY / 2 : 0.08}
										/>
									)}
									{row.members.map((member, memberIndex) => (
										<Track
											key={row.tasks[memberIndex]?.id ?? memberIndex}
											span={member}
											y={TRACK_TOP}
											height={TRACK_H}
											clippedEnd={row.status === 'running' && member.end >= width - 1}
											opacity={row.status === 'abandoned' ? ABANDONED_OPACITY : undefined}
											dashed={row.status === 'abandoned'}
										/>
									))}
									{row.status === 'running' && (
										<Shimmer
											span={row}
											y={TRACK_TOP}
											height={TRACK_H}
											clippedEnd={row.end >= width - 1}
										/>
									)}
									<RequestMarks requests={row.requests} y={TRACK_TOP} height={TRACK_H} />
									{row.waiting.map((stretch) => (
										<rect
											key={stretch.start}
											x={stretch.start}
											y={TRACK_TOP}
											width={stretch.end - stretch.start}
											height={TRACK_H}
											rx={2}
											fill={`url(#${hatch})`}
										/>
									))}
								</g>
							))}
							<Handoffs timeline={timeline} isActive={isActive} />
						</svg>
						<div className="absolute inset-0">
							{timeline.breaks.map((gap) => (
								<BreakTarget key={gap.start} gap={gap} height={height} />
							))}
							{timeline.rows.map((row, index) => (
								<Fragment key={row.id}>
									<RowTarget
										row={row}
										top={index * ROW_H + TRACK_TOP}
										onToggle={() => toggle(row)}
										onHover={(over) => setActive(over ? row.id : null)}
									/>
									<RequestTargets
										requests={row.requests}
										top={index * ROW_H + TRACK_TOP}
										height={TRACK_H}
										connections={connections}
										tooltip={requestTooltip}
										ownTaskId={row.kind === 'task' ? row.id : null}
										titleOf={titleOf}
										onOpen={onOpenEntry}
									/>
								</Fragment>
							))}
							<HandoffTargets timeline={timeline} onHover={setActive} />
						</div>
					</div>
					<AxisLabels ticks={timeline.ticks} width={width}>
						{timeline.breaks.map((gap) => (
							<span
								key={gap.start}
								className={cn(
									'absolute top-1.5 whitespace-nowrap italic',
									(gap.start + gap.end) / 2 < width - 32 ? '-translate-x-1/2' : '-translate-x-full',
								)}
								style={{
									left: (gap.start + gap.end) / 2 < width - 32 ? (gap.start + gap.end) / 2 : width,
								}}
							>
								{roughDuration(gap.idleMs)} idle
							</span>
						))}
					</AxisLabels>
				</div>
			</div>
			<ChartLegend rows={timeline.rows} />
			<RequestTooltip handle={requestTooltip} connections={connections} />
		</div>
	);
}

// A row's name: its task's, indented under what it was handed from, with how long it took, opening
// the task's page for every task but the page's own, at the top; a group's, how many tasks it
// holds. Where a task handed any on, a chevron lays
// them out under it or rolls them back in; a group's lays its tasks out.
function RowLabel({
	row,
	open,
	active,
	onToggle,
	onHover,
}: {
	row: RunRow;
	open: boolean;
	active: boolean;
	onToggle: () => void;
	onHover: (over: boolean) => void;
}) {
	const org = useOrgSlug();
	const back = backFrom(useLocation());
	const [task] = row.tasks;
	const own = row.depth === 0;
	const foldable = row.kind === 'group' || row.rolledIn > 0 || open;
	const chevronLabel =
		row.kind === 'group'
			? `Show the ${row.tasks.length} tasks`
			: `${open ? 'Hide' : 'Show'} the ${row.rolledIn === 1 ? 'sub-task' : `${row.rolledIn} sub-tasks`}`;
	const aside = (
		<span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">
			{formatDuration(row.durationMs)}
		</span>
	);
	return (
		<div
			className={cn('flex items-center', own && 'font-medium', active && 'bg-muted/70')}
			style={{height: ROW_H, paddingLeft: 8 + row.depth * 14}}
			onMouseEnter={() => onHover(true)}
			onMouseLeave={() => onHover(false)}
		>
			{foldable && (
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					aria-label={chevronLabel}
					className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
				>
					{open ? (
						<ChevronDownIcon className="size-3.5" />
					) : (
						<ChevronRightIcon className="size-3.5" />
					)}
				</button>
			)}
			{!foldable && (
				<span className="flex size-5 shrink-0 items-center justify-center">
					{row.depth > 0 && <CornerDownRightIcon className="size-3.5 text-muted-foreground" />}
				</span>
			)}
			{/* The chevron is the group's one stop for the keyboard; its name is a wider place to click. */}
			{row.kind === 'group' && (
				<button
					type="button"
					onClick={onToggle}
					tabIndex={-1}
					aria-hidden
					className="flex h-full min-w-0 flex-1 cursor-pointer items-center pr-3 pl-1 text-left text-muted-foreground hover:text-foreground"
				>
					<span className="truncate">{row.tasks.length} tasks</span>
					{aside}
				</button>
			)}
			{row.kind === 'task' && task && own && (
				<span className="flex h-full min-w-0 flex-1 items-center pr-3 pl-1">
					<span className="truncate">{task.title}</span>
					{aside}
				</span>
			)}
			{row.kind === 'task' && task && !own && (
				<Link
					to={`/${org}/activity/tasks/${encodeURIComponent(task.id)}`}
					state={back}
					preventScrollReset
					className="flex h-full min-w-0 flex-1 items-center pr-3 pl-1 hover:text-foreground"
				>
					<span className="truncate">{task.title}</span>
					{aside}
				</Link>
			)}
		</div>
	);
}

// The target over a row's track: a task's says on hover what it was for and how it went, and
// opens its page, but for the page's own task at the top; a group's lays its tasks out, and says
// on hover which they are.
function RowTarget({
	row,
	top,
	onToggle,
	onHover,
}: {
	row: RunRow;
	top: number;
	onToggle: () => void;
	onHover: (over: boolean) => void;
}) {
	const org = useOrgSlug();
	const back = backFrom(useLocation());
	const [task] = row.tasks;
	const style = {
		left: row.start,
		width: Math.max(row.end - row.start, MIN_TRACK_PX),
		top,
		height: TRACK_H,
	};
	if (row.kind === 'group' || !task) {
		return (
			<ChartTarget
				action={{onClick: onToggle}}
				label={`Show the ${row.tasks.length} tasks`}
				className="cursor-pointer"
				style={style}
				onHover={onHover}
			>
				<TasksTooltip
					heading={`${row.tasks.length} tasks handed on one after another`}
					status={row.status}
					durationMs={row.durationMs}
					requests={row.requests}
					tasks={row.tasks}
				/>
			</ChartTarget>
		);
	}
	return (
		<ChartTarget
			action={
				row.depth === 0
					? null
					: {to: `/${org}/activity/tasks/${encodeURIComponent(task.id)}`, state: back}
			}
			label={task.title}
			style={style}
			onHover={onHover}
		>
			<TaskTooltip
				task={task}
				status={row.status}
				durationMs={row.durationMs}
				requests={row.requests}
				subTasks={row.rolledIn}
			/>
		</ChartTarget>
	);
}

// Where a row's lines meet the track it was handed from: the dot where it was handed on, at the
// bottom edge of that track, a little before the row's start, and the dot where it was handed
// back, a little after its end, each kept on the parent's track; the lines turn into the row's
// track with corners of the radius each has room for.
function handoffOf(timeline: RunLayout, index: number) {
	const row = timeline.rows[index];
	const parent = row?.parentRow === null ? undefined : timeline.rows[row?.parentRow ?? -1];
	if (!row || !parent || row.parentRow === null) {
		return null;
	}
	const clamp = (x: number) =>
		Math.min(Math.max(x, parent.start), Math.max(parent.end, parent.start));
	const from = row.parentRow * ROW_H + ROW_H / 2 + TRACK_H / 2;
	const mid = index * ROW_H + ROW_H / 2;
	const xDown = clamp(row.start - ELBOW);
	const xUp = clamp(row.end + ELBOW);
	return {
		row,
		from,
		mid,
		xDown,
		rDown: Math.min(ELBOW, Math.max(row.start - xDown, 0), mid - from),
		xUp,
		rUp: Math.min(ELBOW, Math.max(xUp - row.end, 0), mid - from),
	};
}

// Where a task handed one on: a dot on the bottom edge of its track, and a line down that turns
// into the start of the task's; where that task was finished by its agent, a line out of its end
// that turns back up to a dot on the track it was handed from. Each line is faint until its row,
// or the row it hangs from, is under the pointer; the dots are a solid gray throughout.
function Handoffs({timeline, isActive}: {timeline: RunLayout; isActive: (row: RunRow) => boolean}) {
	return (
		<g className="pointer-events-none">
			{timeline.rows.map((_, index) => {
				const handoff = handoffOf(timeline, index);
				if (!handoff) {
					return null;
				}
				const {row, from, mid, xDown, rDown, xUp, rUp} = handoff;
				const active = isActive(row);
				const line = cn(
					'fill-none transition-colors',
					active ? 'stroke-foreground/70' : 'stroke-foreground/25',
				);
				return (
					<Fragment key={row.id}>
						<path
							d={`M ${xDown} ${from} V ${mid - rDown} ${rDown > 0 ? `A ${rDown} ${rDown} 0 0 0 ${xDown + rDown} ${mid}` : ''}`}
							strokeWidth={1.5}
							className={line}
						/>
						<Dot cx={xDown} cy={from} />
						{row.handedBack && (
							<>
								<path
									d={`M ${row.end} ${mid} H ${xUp - rUp} ${rUp > 0 ? `A ${rUp} ${rUp} 0 0 0 ${xUp} ${mid - rUp}` : ''} V ${from}`}
									strokeWidth={1.5}
									className={line}
								/>
								<Dot cx={xUp} cy={from} />
							</>
						)}
					</Fragment>
				);
			})}
		</g>
	);
}

// A dot where a line meets the track above it: the gray of a line at rest, the foreground at a
// quarter over the background, but opaque, so it looks the same without showing what is under it.
function Dot({cx, cy}: {cx: number; cy: number}) {
	return (
		<circle
			cx={cx}
			cy={cy}
			r={7 / 3}
			className="fill-[color-mix(in_srgb,var(--foreground)_25%,var(--background))]"
		/>
	);
}

// How wide the target over a dot is, so it is easy to point at.
const DOT_TARGET = 14;

// The targets over the dots: on hover, what was handed on or back there, and when.
function HandoffTargets({
	timeline,
	onHover,
}: {
	timeline: RunLayout;
	onHover: (id: string | null) => void;
}) {
	return (
		<>
			{timeline.rows.map((_, index) => {
				const handoff = handoffOf(timeline, index);
				if (!handoff) {
					return null;
				}
				const {row, from, xDown, xUp} = handoff;
				const [first] = row.tasks;
				const last = row.tasks[row.tasks.length - 1];
				const name = row.kind === 'group' ? `${row.tasks.length} tasks` : `“${first?.title ?? ''}”`;
				const marks = [
					{at: xDown, text: `Handed on ${name}`, when: first?.startedAt ?? null},
					...(row.handedBack
						? [{at: xUp, text: `${name} handed back`, when: last?.finishedAt ?? null}]
						: []),
				];
				// A stop for the keyboard, so when it was handed on or back can be read without a pointer.
				return marks.map((mark) => (
					<Tooltip key={`${row.id}:${mark.at}`} disableHoverablePopup>
						<TooltipTrigger
							render={
								<span
									tabIndex={0}
									role="img"
									aria-label={mark.when ? `${mark.text}, ${formatTime(mark.when)}` : mark.text}
									className="absolute -translate-1/2 rounded-full focus-visible:outline-2 focus-visible:outline-ring"
									style={{left: mark.at, top: from, width: DOT_TARGET, height: DOT_TARGET}}
									onMouseEnter={() => onHover(row.id)}
									onMouseLeave={() => onHover(null)}
								/>
							}
						/>
						<TooltipContent className="pointer-events-none max-w-xs">
							<span className="flex flex-col gap-1">
								<span className="font-medium">{mark.text}</span>
								{mark.when && <span className="opacity-80">{formatTime(mark.when)}</span>}
							</span>
						</TooltipContent>
					</Tooltip>
				));
			})}
		</>
	);
}

// The target over a break: on hover or focus, how long nothing happened.
function BreakTarget({gap, height}: {gap: RunBreak; height: number}) {
	return (
		<Tooltip disableHoverablePopup>
			<TooltipTrigger
				render={
					<span
						tabIndex={0}
						role="img"
						aria-label={`Nothing happened for ${formatDuration(gap.idleMs)}`}
						className="absolute focus-visible:outline-2 focus-visible:outline-ring"
						style={{left: gap.start, width: gap.end - gap.start, top: 0, height}}
					/>
				}
			/>
			<TooltipContent className="pointer-events-none max-w-xs">
				<span className="flex flex-col gap-1">
					<span className="font-medium">Nothing happened for {formatDuration(gap.idleMs)}</span>
					<span className="opacity-80">Folded away, so the busy stretches have the room</span>
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
