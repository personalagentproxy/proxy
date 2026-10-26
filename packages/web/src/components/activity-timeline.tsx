import {Fragment, useEffect, useMemo, useRef, useState} from 'react';
import {Link} from 'react-router';
import {AgentLogo} from '@/components/brand-logo';
import {
	AxisLabels,
	ChartLegend,
	ChartTarget,
	Shimmer,
	RequestMarks,
	RequestTargets,
	RequestTooltip,
	TasksMenu,
	TasksTooltip,
	TaskTooltip,
	Track,
} from '@/components/timeline-chart';
import {useRequestTooltip} from '@/hooks/use-request-tooltip';
import {useTitleOf} from '@/hooks/use-title-of';
import {useChartWidth} from '@/hooks/use-chart-width';
import {useOrgSlug} from '@/hooks/use-org';
import {
	type ActivityBar,
	type ActivityRow,
	type ActivityTimeline as ActivityLayout,
	keyOf,
	laneAssignments,
	layActivityTimeline,
	lanesEverywhere,
	type LanePreferences,
	prepareActivityTimeline,
	type Window,
} from '@/lib/activity-timeline';
import {LEFT_OPEN_OPACITY, MIN_TRACK_PX, TASK_COLOR_CLASS} from '@/lib/timeline';
import {zoomedOn} from '@/lib/timeline-window';
import type {ActivityTask, AgentLogin, AuditEntry, Connection} from '@/lib/types';
import {cn} from '@proxy/ui/lib/utils';

// A lane's height and its bar's, and the room above and below an agent's lanes, in pixels. The
// requests run along the bottom of a bar, under its name.
const LANE_H = 26;
const BAR_H = 20;
const ROW_PAD = 6;
const REQUEST_H = 4;
const REQUEST_INSET = 2;

// A bar at least this wide carries its task's name.
const MIN_NAMED_PX = 56;

// How long a row takes to grow, shrink or fade; and how long after the window last moved a row,
// or a lane of one, that is no longer needed is taken away: while the window is still moving,
// rows only grow, so nothing jumps under the pointer.
const MOTION_MS = 300;
const SETTLE_MS = 1000;

const LABEL = 'w-44 shrink-0 md:w-56';

// What marks the chart beside the agents' names, for the wheel to measure (agent-timeline.tsx).
export const CHART_ATTRIBUTE = 'data-timeline-chart';

// What slides to its new lane: a change of top, or of the transform that places a bar's shapes.
const MOVES = 'transition-[top,transform] duration-300 ease-in-out motion-reduce:transition-none';

const laneHeight = (lanes: number) => lanes * LANE_H + 2 * ROW_PAD;
const barTop = (lane: number) => ROW_PAD + lane * LANE_H + (LANE_H - BAR_H) / 2;

type Props = {
	tasks: ActivityTask[];
	entries: AuditEntry[];
	// When the answer was read: where a task under way has got to.
	now: string;
	window: Window;
	agents: AgentLogin[];
	connections: Connection[];
	onOpenEntry: (entry: AuditEntry) => void;
	// Zoom the window in on a stretch of time, in milliseconds since the epoch.
	onZoom: (from: number, to: number) => void;
	// The windows the view is about to pass through, zooming in on a bar, in order; none otherwise.
	// Rows make room for every one of them as the zoom sets off, so they move with it.
	ahead: Window[];
	// Where a task's page comes back to: this page, with the window as it is.
	backTo: string;
};

// Who is doing what (the layout in lib/activity-timeline.ts): every agent's row over a window of
// time, a bar for every task it was given, named where there is room, the requests made for it
// along the bar's bottom as long as each took, blocked ones amber and failed ones red. Tasks under
// way at once each take a lane of the row; short ones close together are one bar, which zooms in on
// them, or, where zooming in would make the window no shorter, lists them to open one. A bar says
// more on hover and opens the task's page; a request opens in full; an agent's
// name opens the agent's page. As the window moves, a row or lane that comes into need grows in at
// once, while bars keep their lanes and rows their order, and zooming in on a bar, rows make room
// for the whole way at once; a second after the window comes to rest, bars settle into the lowest
// lanes, and rows and lanes no longer needed shrink away.
export function ActivityTimeline({
	tasks,
	entries,
	now,
	window,
	agents,
	connections,
	onOpenEntry,
	onZoom,
	ahead,
	backTo,
}: Props) {
	const [measure, width] = useChartWidth();
	const requestTooltip = useRequestTooltip();
	const [preferred, setPreferred] = useState<LanePreferences>(() => new Map());
	// What doesn't change as the window moves is worked out once for every window.
	const prepared = useMemo(
		() => prepareActivityTimeline(tasks, entries, new Date(now)),
		[tasks, entries, now],
	);
	// Zooming in on a bar, every bar keeps the lane it ends up in the whole way, overlapping for a
	// moment rather than opening lanes that would be empty again at the end: the layout where the
	// zoom ends is made first, afresh, so its lanes are the fewest, and the lanes it gives go before
	// every other preference.
	// What the zoom's way gives is the same on every frame of it, so it is laid out once.
	const {final, lanes, laidAhead} = useMemo(() => {
		const destination = ahead.at(-1);
		const final = destination ? layActivityTimeline(prepared, destination, width) : null;
		const lanes = final ? new Map([...preferred, ...lanesEverywhere(final)]) : preferred;
		const laidAhead = ahead.map((coming) =>
			layActivityTimeline(prepared, coming, width, lanes, true),
		);
		return {final, lanes, laidAhead};
	}, [prepared, ahead, width, preferred]);
	const timeline = layActivityTimeline(prepared, window, width, lanes, final !== null);
	const rows = useSettledRows(timeline, laidAhead, window, preferred, setPreferred);
	const titleOf = useTitleOf(tasks);
	const nowAt = timeline.ticks.find((tick) => tick.label === 'Now');
	// A row's box as it is drawn: full while shown, nothing while coming or going, and then out of
	// reach of the keyboard too, as it can't be seen.
	const rowStyle = (row: ShownRow) => ({
		height: row.phase === 'shown' ? laneHeight(row.lanes) : 0,
		opacity: row.phase === 'shown' ? 1 : 0,
	});
	const rowClass =
		'overflow-hidden transition-[height,opacity] duration-300 ease-in-out motion-reduce:transition-none [&:not(:first-child)]:border-t';

	return (
		<div className="flex flex-col gap-3 text-sm">
			<div className="flex overflow-hidden rounded-lg border">
				<div className={cn(LABEL, 'min-w-0 border-r bg-muted/40')}>
					{rows.map((row) => (
						<div
							key={row.agentId}
							className={rowClass}
							style={rowStyle(row)}
							inert={row.phase !== 'shown'}
						>
							<AgentLabel
								row={row.row}
								agent={agents.find((candidate) => candidate.id === row.agentId)}
								height={laneHeight(row.lanes)}
							/>
						</div>
					))}
					<div className="h-7" />
				</div>
				<div className="min-w-0 flex-1 px-4">
					<div ref={measure} className="relative" {...{[CHART_ATTRIBUTE]: ''}}>
						<svg aria-hidden className="absolute inset-0 h-full w-full overflow-hidden">
							{timeline.ticks.map((tick) => (
								<line
									key={tick.px}
									x1={tick.px}
									x2={tick.px}
									y1={0}
									y2="100%"
									className={tick === nowAt ? 'stroke-foreground/40' : 'stroke-border/70'}
								/>
							))}
						</svg>
						{rows.map((row) => (
							<div
								key={row.agentId}
								className={cn(rowClass, 'relative')}
								style={rowStyle(row)}
								inert={row.phase !== 'shown'}
							>
								<svg
									width={width}
									height={laneHeight(row.lanes)}
									className={cn('absolute top-0 left-0 block', TASK_COLOR_CLASS)}
								>
									{barsOf(row).map(({bar, laneIndex}) => (
										// The fade on coming in is on an inner group: its keyframes set a transform
										// of their own, which must not undo the one that places the bar.
										<g
											key={keyOf(bar)}
											className={MOVES}
											style={{transform: `translate(0, ${barTop(laneIndex)}px)`}}
										>
											<g className="animate-in fade-in-0 duration-300 motion-reduce:animate-none">
												<Track
													span={bar}
													y={0}
													height={BAR_H}
													clippedStart={bar.clippedStart}
													clippedEnd={bar.clippedEnd}
													opacity={bar.status === 'leftOpen' ? LEFT_OPEN_OPACITY : undefined}
													dashed={bar.status === 'leftOpen'}
												/>
												{bar.status === 'running' && (
													<Shimmer
														span={bar}
														y={0}
														height={BAR_H}
														clippedStart={bar.clippedStart}
														clippedEnd={bar.clippedEnd}
													/>
												)}
												<RequestMarks
													requests={bar.requests}
													y={BAR_H - REQUEST_INSET - REQUEST_H}
													height={REQUEST_H}
												/>
											</g>
										</g>
									))}
								</svg>
								<div
									className="absolute top-0 left-0 w-full"
									style={{height: laneHeight(row.lanes)}}
								>
									{barsOf(row).map(({bar, laneIndex}) => (
										<Fragment key={keyOf(bar)}>
											{(bar.tasks.length > 1 || bar.end - bar.start >= MIN_NAMED_PX) && (
												<span
													aria-hidden
													className={cn(
														MOVES,
														'pointer-events-none absolute truncate text-[11px] leading-3 text-foreground/90',
													)}
													style={{
														left: bar.start + 6,
														top: barTop(laneIndex) + 2,
														width: bar.end - bar.start - 12,
													}}
												>
													{bar.tasks.length > 1 ? `${bar.tasks.length} tasks` : bar.tasks[0]?.title}
												</span>
											)}
											<BarTarget
												bar={bar}
												top={barTop(laneIndex)}
												windowMs={window.to.getTime() - window.from.getTime()}
												onZoom={onZoom}
												backTo={backTo}
											/>
											<RequestTargets
												requests={bar.requests}
												top={barTop(laneIndex)}
												height={BAR_H}
												connections={connections}
												tooltip={requestTooltip}
												ownTaskId={bar.tasks.length === 1 ? (bar.tasks[0]?.id ?? null) : null}
												titleOf={titleOf}
												onOpen={onOpenEntry}
											/>
										</Fragment>
									))}
								</div>
							</div>
						))}
					</div>
					<AxisLabels ticks={timeline.ticks} width={width} />
				</div>
			</div>
			<ChartLegend rows={rows.flatMap((row) => row.row?.lanes.flat() ?? [])} />
			<RequestTooltip handle={requestTooltip} connections={connections} />
		</div>
	);
}

// A row's bars with the lane each is in, as one list in a fixed order, so a bar that changes lane
// stays the same element and slides there, rather than being drawn anew.
function barsOf(row: ShownRow): Array<{bar: ActivityBar; laneIndex: number}> {
	return (row.row?.lanes ?? [])
		.flatMap((lane, laneIndex) => lane.map((bar) => ({bar, laneIndex})))
		.sort((a, b) => keyOf(a.bar).localeCompare(keyOf(b.bar)));
}

// A row as it is shown: the agent's row from the layout, or none while the row is kept after its
// tasks left the window; how many lanes tall it is drawn, never fewer than it had until the window
// comes to rest; and whether it is coming, there or going.
type ShownRow = {
	agentId: string;
	row: ActivityRow | null;
	lanes: number;
	phase: 'entering' | 'shown' | 'leaving';
};

// A row kept on screen, with the lanes it is drawn at.
type Held = {agentId: string; lanes: number};

// The rows to draw for the layout's rows: the layout's, and those kept from before the window
// moved, in the order they came, each as tall as the most it has needed since the window last came
// to rest. A new row comes in a moment after it is first drawn, so it grows from nothing. The
// lane every bar is in is remembered, so the layout gives it the same one next time. A second
// after the window stops moving, bars settle into the lowest lanes, a row whose agent has left
// the window or that needs fewer lanes is let go, and one let go fades out before it is taken away.
function useSettledRows(
	timeline: ActivityLayout,
	ahead: ActivityLayout[],
	window: Window,
	preferred: LanePreferences,
	setPreferred: (next: LanePreferences) => void,
): ShownRow[] {
	const {rows} = timeline;
	const [held, setHeld] = useState<Held[]>([]);
	const [entered, setEntered] = useState<ReadonlySet<string>>(() => new Set());
	const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
	// The layout's shape the kept rows were last raised to.
	const [seen, setSeen] = useState('');

	const byAgent = new Map(rows.map((row) => [row.agentId, row]));
	// The layout's rows slot in among those kept, each before the first kept row the layout puts
	// after it; then those of the layouts ahead, the same way.
	const order = held.map((one) => one.agentId);
	for (const layout of [timeline, ...ahead]) {
		layout.rows.forEach((row, index) => {
			if (order.includes(row.agentId)) {
				return;
			}
			const after = layout.rows
				.slice(index + 1)
				.find((candidate) => order.includes(candidate.agentId));
			order.splice(after ? order.indexOf(after.agentId) : order.length, 0, row.agentId);
		});
	}
	// What is kept now: what the layout needs, and what any layout ahead will, never less than
	// what was kept.
	const kept = order.map((agentId) => ({
		agentId,
		lanes: Math.max(
			byAgent.get(agentId)?.lanes.length ?? 0,
			held.find((one) => one.agentId === agentId)?.lanes ?? 0,
			...ahead.map(
				(layout) => layout.rows.find((row) => row.agentId === agentId)?.lanes.length ?? 0,
			),
		),
	}));
	// As the layout changes shape, what is kept grows with it at once, a row on its way out whose
	// agent is back stays, and every bar's lane is remembered.
	const signature = [timeline, ...ahead]
		.map((layout) =>
			layout.rows
				.map(
					(row) => `${row.agentId}:${row.lanes.map((lane) => lane.map(keyOf).join('+')).join('/')}`,
				)
				.join(','),
		)
		.join(';');
	if (signature !== seen) {
		setSeen(signature);
		if (
			kept.length !== held.length ||
			kept.some(
				(one, index) => one.agentId !== held[index]?.agentId || one.lanes !== held[index]?.lanes,
			)
		) {
			setHeld(kept);
		}
		if ([...leaving].some((agentId) => byAgent.has(agentId))) {
			setLeaving(new Set([...leaving].filter((agentId) => !byAgent.has(agentId))));
		}
		// Every bar's lane is remembered; zooming in on a bar, the lanes where the zoom ends come
		// first, so bars head there from the start.
		const assigned = new Map([
			...laneAssignments(timeline),
			...laneAssignments(ahead.at(-1) ?? timeline),
		]);
		if ([...assigned].some(([key, lane]) => preferred.get(key) !== lane)) {
			setPreferred(new Map([...preferred, ...assigned]));
		}
	}
	const shown = kept
		.map((one): ShownRow => {
			const phase = leaving.has(one.agentId)
				? 'leaving'
				: entered.has(one.agentId)
					? 'shown'
					: 'entering';
			return {agentId: one.agentId, row: byAgent.get(one.agentId) ?? null, lanes: one.lanes, phase};
		})
		.filter((row) => row.lanes > 0);

	// What the settle timer works from: the layout and the kept rows as they last were.
	const latest = useRef({timeline, kept});
	useEffect(() => {
		latest.current = {timeline, kept};
	});

	// A frame after a row is first drawn, it is there, so it grows from nothing.
	const present = rows.map((row) => row.agentId).join(',');
	useEffect(() => {
		const timer = setTimeout(() => {
			setEntered((current) => {
				const next = new Set([...current, ...present.split(',').filter(Boolean)]);
				return next.size === current.size ? current : next;
			});
		}, 20);
		return () => clearTimeout(timer);
	}, [present]);

	// A second after the window last moved, bars settle into the lowest lanes, and rows and lanes
	// no longer needed go.
	const from = window.from.getTime();
	const to = window.to.getTime();
	useEffect(() => {
		let fade: ReturnType<typeof setTimeout> | undefined;
		const settle = setTimeout(() => {
			const needed = new Map(
				latest.current.timeline.rows.map((row) => [
					row.agentId,
					row.lanes.filter((lane) => lane.length > 0).length,
				]),
			);
			setPreferred(laneAssignments(latest.current.timeline, true));
			setHeld((current) =>
				current.map((one) => ({...one, lanes: needed.get(one.agentId) ?? one.lanes})),
			);
			const gone = latest.current.kept
				.filter((one) => !needed.has(one.agentId))
				.map((one) => one.agentId);
			if (gone.length === 0) {
				return;
			}
			setLeaving(new Set(gone));
			fade = setTimeout(() => {
				setHeld((current) => current.filter((one) => !gone.includes(one.agentId)));
				setEntered((current) => new Set([...current].filter((agentId) => !gone.includes(agentId))));
				setLeaving(new Set());
			}, MOTION_MS);
		}, SETTLE_MS);
		return () => {
			clearTimeout(settle);
			if (fade !== undefined) {
				clearTimeout(fade);
			}
		};
	}, [from, to, setPreferred]);

	return shown;
}

// An agent's row is named by the agent, opening its page, with how many tasks it has under way,
// or had in the window; one deleted since has an empty tile.
function AgentLabel({
	row,
	agent,
	height,
}: {
	row: ActivityRow | null;
	agent: AgentLogin | undefined;
	height: number;
}) {
	const org = useOrgSlug();
	const count = row?.lanes.flat().reduce((total, bar) => total + bar.tasks.length, 0) ?? 0;
	const working = row?.working ?? 0;
	const aside = row && (
		<span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">
			{working > 0 ? `${working} under way` : `${count} ${count === 1 ? 'task' : 'tasks'}`}
		</span>
	);
	// Level with the first lane's bar, rather than in the middle of however many lanes there are.
	const className = 'flex items-center gap-2 pr-3 pl-3';
	const style = {height, paddingTop: barTop(0), paddingBottom: height - barTop(0) - BAR_H};
	if (!agent) {
		return (
			<div className={className} style={style}>
				<span className="size-5 shrink-0 rounded-md border border-dashed" />
				<span className="truncate font-medium">Deleted agent</span>
				{aside}
			</div>
		);
	}
	return (
		<Link
			to={`/${org}/agents/${encodeURIComponent(agent.id)}`}
			className={cn(className, 'hover:bg-muted')}
			style={style}
		>
			<AgentLogo providerId={agent.providerId} />
			<span className="truncate font-medium">{agent.name}</span>
			{aside}
		</Link>
	);
}

// The target over a bar: a task's opens its page, and says on hover what it was for and how it
// went; one of several tasks zooms the window in on them, or, where the window is as short as
// zooming in on them would make it, lists them to open one; and says on hover which they are.
function BarTarget({
	bar,
	top,
	windowMs,
	onZoom,
	backTo,
}: {
	bar: ActivityBar;
	top: number;
	windowMs: number;
	onZoom: (from: number, to: number) => void;
	backTo: string;
}) {
	const org = useOrgSlug();
	const [task] = bar.tasks;
	const style = {
		left: bar.start,
		width: Math.max(bar.end - bar.start, MIN_TRACK_PX),
		top,
		height: BAR_H,
	};
	const className = cn(MOVES, 'hover:bg-foreground/5');
	const pageOf = (one: ActivityTask) => ({
		to: `/${org}/activity/tasks/${encodeURIComponent(one.id)}`,
		state: {back: backTo, then: null},
	});
	if (!task) {
		return null;
	}
	if (bar.tasks.length > 1 && zoomedOn(bar.fromMs, bar.toMs) < windowMs) {
		return (
			<ChartTarget
				action={{onClick: () => onZoom(bar.fromMs, bar.toMs)}}
				label={`Zoom in on ${bar.tasks.length} tasks`}
				className={cn(className, 'cursor-zoom-in')}
				style={style}
			>
				<TasksTooltip
					heading={`${bar.tasks.length} tasks close together`}
					status={bar.status}
					durationMs={bar.durationMs}
					requests={bar.requests}
					tasks={bar.tasks}
					hint="Click to zoom in on them"
				/>
			</ChartTarget>
		);
	}
	if (bar.tasks.length > 1) {
		return (
			<ChartTarget
				action={{
					menu: (
						<TasksMenu
							heading={`${bar.tasks.length} tasks close together`}
							status={bar.status}
							durationMs={bar.durationMs}
							requests={bar.requests}
							tasks={bar.tasks}
							pageOf={pageOf}
						/>
					),
				}}
				label={`Choose one of ${bar.tasks.length} tasks`}
				className={className}
				style={style}
			>
				<TasksTooltip
					heading={`${bar.tasks.length} tasks close together`}
					status={bar.status}
					durationMs={bar.durationMs}
					requests={bar.requests}
					tasks={bar.tasks}
					hint="Click to choose one"
				/>
			</ChartTarget>
		);
	}
	return (
		<ChartTarget action={pageOf(task)} label={task.title} className={className} style={style}>
			<TaskTooltip
				task={task}
				status={bar.status}
				durationMs={bar.durationMs}
				requests={bar.requests}
				subTasks={bar.subTasks}
			/>
		</ChartTarget>
	);
}
