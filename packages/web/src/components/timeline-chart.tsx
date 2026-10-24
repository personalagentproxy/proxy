import {type CSSProperties, memo, type ReactNode, useId} from 'react';
import {Link} from 'react-router';
import type {RequestTooltipHandle} from '@/hooks/use-request-tooltip';
import type {Back} from '@/lib/back';
import {connectionLabel, describeEntry, locateEntry} from '@/lib/access';
import {formatTime} from '@/lib/format';
import {
	ABANDONED_OPACITY,
	formatDuration,
	merged,
	MIN_TRACK_PX,
	requestSummary,
	type Span,
	TRACK_OPACITY,
	type TimelineRequest,
	TASK_COLOR_CLASS,
} from '@/lib/timeline';
import {STATUS_LABEL, type TaskStatus} from '@/lib/timeline-window';
import type {ActivityTask, AuditEntry, Connection} from '@/lib/types';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';

// What the two timelines draw with. A chart is an SVG the width of its box, measured as it
// resizes, with a layer of hit targets over it: the drawing is plain shapes, and everything that
// says more on hover or opens on click is an element with a name. The tasks' blue (the layout's
// TASK_COLOR_CLASS) is set as the text color, which the shapes take as currentColor: a task is a
// faint track of it, with the requests made for the task solid on it; the hatching, the lines between
// rows and the axis are in the foreground's grays; amber and red are kept for a request blocked
// or failed, what may need the person, drawn on the track as the others are.

// A request blocked, amber, or failed, red: what may need the person.
const OUTCOME_FILL: Record<'denied' | 'failed', string> = {
	denied: 'fill-amber-500',
	failed: 'fill-red-500',
};

/** The hatching a task wears while it waits on what it handed on: thin lines at 45°. */
export function HatchDefs({id}: {id: string}) {
	return (
		<defs>
			<pattern
				id={id}
				patternUnits="userSpaceOnUse"
				width="6"
				height="6"
				patternTransform="rotate(45)"
				className="text-foreground/35"
			>
				<line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="1.2" />
			</pattern>
		</defs>
	);
}

// Where a track is drawn: run on past the chart's edge where the chart cuts it off, so that side
// stays square, and never narrower than the least.
function trackBox(
	span: Span,
	clippedStart: boolean,
	clippedEnd: boolean,
): {x: number; width: number} {
	const start = clippedStart ? span.start - 8 : span.start;
	const end = clippedEnd ? span.end + 8 : span.end;
	return {x: start, width: Math.max(end - start, MIN_TRACK_PX)};
}

/** A task's track: a rounded bar, square where it runs past the chart's edge. */
export function Track({
	span,
	y,
	height,
	clippedStart = false,
	clippedEnd = false,
	opacity = TRACK_OPACITY,
	dashed = false,
}: {
	span: Span;
	y: number;
	height: number;
	clippedStart?: boolean;
	clippedEnd?: boolean;
	opacity?: number;
	dashed?: boolean;
}) {
	const {x, width} = trackBox(span, clippedStart, clippedEnd);
	return (
		<rect
			x={x}
			y={y}
			width={width}
			height={height}
			rx={4}
			fill="currentColor"
			fillOpacity={opacity}
			stroke={dashed ? 'currentColor' : 'none'}
			strokeOpacity={0.5}
			strokeDasharray={dashed ? '3 3' : undefined}
		/>
	);
}

// The shimmer's band, at most, how fast it sweeps, and how much of each turn it rests after a sweep.
const SHIMMER_BAND_PX = 96;
const SHIMMER_PX_PER_S = 220;
const SHIMMER_MIN_S = 1.2;
const SHIMMER_REST = 0.35;

/**
 * A light that sweeps along a task's track while it is under way, again and again, a band of the
 * task's color a little stronger than the track, resting a moment after each sweep: at the same
 * speed on every track, so a long one takes longer, and with a band no wider than the track. None
 * where motion is to be kept down.
 */
export function Shimmer({
	span,
	y,
	height,
	clippedStart = false,
	clippedEnd = false,
}: {
	span: Span;
	y: number;
	height: number;
	clippedStart?: boolean;
	clippedEnd?: boolean;
}) {
	const id = useId();
	if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
		return null;
	}
	const {x, width} = trackBox(span, clippedStart, clippedEnd);
	const band = Math.min(SHIMMER_BAND_PX, width);
	const travel = width + band;
	const sweepS = Math.max(travel / SHIMMER_PX_PER_S, SHIMMER_MIN_S);
	return (
		<>
			<defs>
				<linearGradient id={id} gradientUnits="userSpaceOnUse" x1={x - band} x2={x} y1={0} y2={0}>
					<stop offset="0" stopColor="currentColor" stopOpacity={0} />
					<stop offset="0.5" stopColor="currentColor" stopOpacity={0.3} />
					<stop offset="1" stopColor="currentColor" stopOpacity={0} />
					<animateTransform
						attributeName="gradientTransform"
						type="translate"
						values={`0 0; ${travel} 0; ${travel} 0`}
						keyTimes={`0; ${1 - SHIMMER_REST}; 1`}
						dur={`${sweepS / (1 - SHIMMER_REST)}s`}
						repeatCount="indefinite"
					/>
				</linearGradient>
			</defs>
			<rect x={x} y={y} width={width} height={height} rx={4} fill={`url(#${id})`} />
		</>
	);
}

/**
 * The requests made for a task, solid on its track, those that touch drawn as one: in the task's
 * color, or over it in amber where blocked and red where failed.
 */
export const RequestMarks = memo(function RequestMarks({
	requests,
	y,
	height,
}: {
	requests: TimelineRequest[];
	y: number;
	height: number;
}) {
	const marks = (outcome: AuditEntry['outcome']) =>
		merged(
			requests.filter((request) => request.entry.outcome === outcome),
			1,
		).map((span) => (
			<rect
				key={`${outcome}-${span.start}`}
				x={span.start}
				y={y}
				width={span.end - span.start}
				height={height}
				rx={Math.min(2, height / 2)}
				fill={outcome === 'allowed' ? 'currentColor' : undefined}
				className={outcome === 'allowed' ? undefined : OUTCOME_FILL[outcome]}
			/>
		));
	return (
		<>
			{marks('allowed')}
			{marks('denied')}
			{marks('failed')}
		</>
	);
});

// How many of a group's tasks are named on hover before the rest are counted.
const MAX_NAMED = 8;

/** The tasks of a group, named one under another, the rest counted. */
function TaskNames({tasks}: {tasks: ActivityTask[]}) {
	return (
		<span className="flex flex-col opacity-80">
			<ul className="list-disc pl-4">
				{tasks.slice(0, MAX_NAMED).map((task) => (
					<li key={task.id}>{task.title}</li>
				))}
			</ul>
			{tasks.length > MAX_NAMED && <span>{tasks.length - MAX_NAMED} more</span>}
		</span>
	);
}

/** What a task's tooltip says: its name and how it went. */
export function TaskTooltip({
	task,
	status,
	durationMs,
	requests,
	subTasks,
}: {
	task: ActivityTask;
	status: TaskStatus;
	durationMs: number;
	requests: TimelineRequest[];
	subTasks: number;
}) {
	const parts = [
		`${STATUS_LABEL[status]} · ${formatDuration(durationMs)}`,
		...requestSummary(requests),
		...(subTasks > 0 ? [`${subTasks} ${subTasks === 1 ? 'sub-task' : 'sub-tasks'}`] : []),
	];
	return (
		<span className="flex flex-col gap-1">
			<span className="font-medium">{task.title}</span>
			<span className="opacity-80">{parts.join(' · ')}</span>
		</span>
	);
}

/**
 * What a bar or row of several tasks says on hover, worked out only once it is open: how many, how
 * they went and which they are, and what clicking it does.
 */
export function TasksTooltip({
	heading,
	status,
	durationMs,
	requests,
	tasks,
	hint,
}: {
	heading: string;
	status: TaskStatus;
	durationMs: number;
	requests: TimelineRequest[];
	tasks: ActivityTask[];
	hint?: string;
}) {
	return (
		<span className="flex flex-col gap-1">
			<span className="font-medium">{heading}</span>
			<span className="opacity-80">
				{[
					`${STATUS_LABEL[status]} · ${formatDuration(durationMs)}`,
					...requestSummary(requests),
				].join(' · ')}
			</span>
			<TaskNames tasks={tasks} />
			{hint && <span>{hint}</span>}
		</span>
	);
}

/**
 * A hit target over a track, in the layer over the chart, saying more on hover or focus: a link to
 * a task's page, coming back the way `state` says (lib/back.ts); a button; or, where it opens
 * nothing, a stop for the keyboard all the same, so what it says can be reached.
 */
export function ChartTarget({
	action,
	label,
	className,
	style,
	onHover,
	children,
}: {
	action: {to: string; state: Back} | {onClick: () => void} | null;
	label: string;
	className?: string;
	style: CSSProperties;
	onHover?: (over: boolean) => void;
	children: ReactNode;
}) {
	const shared = {
		'aria-label': label,
		className: cn(
			'absolute rounded-md focus-visible:outline-2 focus-visible:outline-ring',
			className,
		),
		style,
		onMouseEnter: onHover && (() => onHover(true)),
		onMouseLeave: onHover && (() => onHover(false)),
	};
	const trigger = () => {
		if (action === null) {
			return <span tabIndex={0} role="img" {...shared} />;
		}
		if ('to' in action) {
			return <Link to={action.to} state={action.state} preventScrollReset {...shared} />;
		}
		return <button type="button" onClick={action.onClick} {...shared} />;
	};
	return (
		<Tooltip disableHoverablePopup>
			<TooltipTrigger render={trigger()} />
			<TooltipContent className="pointer-events-none max-w-xs">{children}</TooltipContent>
		</Tooltip>
	);
}

/**
 * A chart's one tooltip for its requests, saying of the one under the pointer what it was, where
 * and how long it took, and why it didn't go through: one for them all, rather than one each, as
 * a chart has a target for every request and draws them all again as the window moves.
 */
export function RequestTooltip({
	handle,
	connections,
}: {
	handle: RequestTooltipHandle;
	connections: Connection[];
}) {
	return (
		<Tooltip handle={handle} disableHoverablePopup>
			{({payload}) =>
				payload && (
					<TooltipContent className="pointer-events-none max-w-xs">
						<RequestDetails
							entry={payload.entry}
							connections={connections}
							forTask={payload.forTask}
						/>
					</TooltipContent>
				)
			}
		</Tooltip>
	);
}

// A hit target over a request's stretch of the track, in the layer over the chart: on hover, the
// chart's request tooltip says what it was; a click opens it in full.
function RequestTarget({
	request,
	top,
	height,
	connections,
	tooltip,
	forTask,
	onOpen,
}: {
	request: TimelineRequest;
	top: number;
	height: number;
	connections: Connection[];
	tooltip: RequestTooltipHandle;
	// The task it was made for, where that is one rolled into the row's.
	forTask: string | null;
	onOpen: () => void;
}) {
	const {entry} = request;
	const located = locateEntry(connections, entry);
	// One that didn't go through is always pointed at, so its target is never narrower than the
	// least, centred on its stretch.
	const width = Math.max(
		request.end - request.start,
		entry.outcome === 'allowed' ? 0 : MIN_TARGET_PX,
	);
	const left = (request.start + request.end - width) / 2;
	return (
		<TooltipTrigger
			handle={tooltip}
			payload={{entry, forTask}}
			render={
				<button
					type="button"
					onClick={onOpen}
					aria-label={describeEntry(entry, located)}
					className="absolute cursor-pointer rounded-sm transition-[top] duration-300 ease-in-out hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none"
					style={{left, top, width, height}}
				/>
			}
		/>
	);
}

// What a request's tooltip says, worked out only once it is open: a timeline has a target for
// every request, and draws them all again as the window moves.
function RequestDetails({
	entry,
	connections,
	forTask,
}: {
	entry: AuditEntry;
	connections: Connection[];
	forTask: string | null;
}) {
	const located = locateEntry(connections, entry);
	const where = located ? connectionLabel(connections, located.connection) : 'Deleted connection';
	const duration = entry.durationMs === null ? null : formatDuration(entry.durationMs);
	return (
		<span className="flex flex-col gap-1">
			<span className="font-medium">{describeEntry(entry, located)}</span>
			<span className="opacity-80">
				{where} · {formatTime(entry.at)}
				{duration && ` · ${duration}`}
			</span>
			{forTask && <span className="opacity-80">For “{forTask}”</span>}
			{entry.outcome === 'denied' && <span>Blocked: the agent may not do this</span>}
			{entry.outcome === 'failed' && <span>Failed{entry.error ? `: ${entry.error}` : ''}</span>}
		</span>
	);
}

// The least a request is wide to get a target of its own, where it isn't marked.
const MIN_TARGET_PX = 8;

/**
 * The targets for a row's requests: every one that didn't go through, and every other where its
 * stretch of the track is wide enough to point at.
 */
export const RequestTargets = memo(function RequestTargets({
	requests,
	top,
	height,
	connections,
	tooltip,
	ownTaskId,
	titleOf,
	onOpen,
}: {
	requests: TimelineRequest[];
	top: number;
	height: number;
	connections: Connection[];
	tooltip: RequestTooltipHandle;
	// The row's own task, whose requests aren't named as made for it; null for a row of several.
	ownTaskId: string | null;
	// The name of the task a request was made for, where that is one rolled into the row's.
	titleOf: (taskId: string | null) => string | null;
	onOpen: (entry: AuditEntry) => void;
}) {
	return (
		<>
			{requests
				.filter(
					(request) =>
						request.entry.outcome !== 'allowed' || request.end - request.start >= MIN_TARGET_PX,
				)
				.map((request) => (
					<RequestTarget
						key={request.entry.id}
						request={request}
						top={top}
						height={height}
						connections={connections}
						tooltip={tooltip}
						forTask={
							ownTaskId !== null && request.entry.taskId === ownTaskId
								? null
								: titleOf(request.entry.taskId)
						}
						onOpen={() => onOpen(request.entry)}
					/>
				))}
		</>
	);
});

/** The labels under the axis, each centred on its mark but kept inside the chart at either end. */
export function AxisLabels({
	ticks,
	width,
	children,
}: {
	ticks: Array<{px: number; label: string}>;
	width: number;
	children?: ReactNode;
}) {
	return (
		<div className="relative h-7 text-xs text-muted-foreground tabular-nums">
			{ticks.map((tick) => (
				<span
					key={tick.px}
					className={cn(
						'absolute top-1.5 whitespace-nowrap',
						tick.px > 24 && tick.px < width - 24 && '-translate-x-1/2',
						tick.px >= width - 24 && '-translate-x-full',
					)}
					style={{left: tick.px}}
				>
					{tick.label}
				</span>
			))}
			{children}
		</div>
	);
}

// What the legend can tell of in a row of a chart: how its task stands, the requests made for it
// and, on a task's page, where it waited on what it handed on.
type LegendRow = {status: TaskStatus; requests: TimelineRequest[]; waiting?: Span[]};

/**
 * The key to the marks on a chart, only for those on it: a task's track with its requests always,
 * and the hatching, the shimmer, the dashed track and the amber and red requests while any row has
 * them. The rest
 * the chart tells itself, on hover or on the axis.
 */
export function ChartLegend({rows}: {rows: LegendRow[]}) {
	const any = (test: (row: LegendRow) => boolean) => rows.some(test);
	const waiting = any((row) => (row.waiting ?? []).length > 0);
	const running = any((row) => row.status === 'running');
	const abandoned = any((row) => row.status === 'abandoned');
	const blocked = any((row) => row.requests.some((request) => request.entry.outcome === 'denied'));
	const failed = any((row) => row.requests.some((request) => request.entry.outcome === 'failed'));
	return (
		<div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<Key swatch={<TrackSwatch requests />}>Task and its requests</Key>
			{waiting && <Key swatch={<TrackSwatch hatched />}>Waiting on sub-tasks</Key>}
			{running && <Key swatch={<TrackSwatch running />}>Under way</Key>}
			{abandoned && <Key swatch={<TrackSwatch abandoned />}>Given up</Key>}
			{blocked && <Key swatch={<TrackSwatch outcome="denied" />}>Blocked</Key>}
			{failed && <Key swatch={<TrackSwatch outcome="failed" />}>Failed</Key>}
		</div>
	);
}

function Key({swatch, children}: {swatch: ReactNode; children: ReactNode}) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className="flex items-center">{swatch}</span>
			{children}
		</span>
	);
}

/**
 * A swatch of a task's track, for the legend: with requests on it, hatched, under way, given up, or
 * with a request blocked or failed.
 */
function TrackSwatch({
	requests = false,
	hatched = false,
	running = false,
	abandoned = false,
	outcome,
}: {
	requests?: boolean;
	hatched?: boolean;
	running?: boolean;
	abandoned?: boolean;
	outcome?: 'denied' | 'failed';
}) {
	return (
		<svg width="24" height="12" className={cn('block', TASK_COLOR_CLASS)} aria-hidden>
			{hatched && <HatchDefs id="legend-hatch" />}
			<Track
				span={{start: 0, end: 24}}
				y={1}
				height={10}
				opacity={abandoned ? ABANDONED_OPACITY : undefined}
				dashed={abandoned}
			/>
			{requests && <rect x="3" y="1" width="7" height="10" rx="2" fill="currentColor" />}
			{requests && <rect x="14" y="1" width="4" height="10" rx="2" fill="currentColor" />}
			{hatched && <rect y="1" width="24" height="10" rx="3" fill="url(#legend-hatch)" />}
			{running && <Shimmer span={{start: 0, end: 24}} y={1} height={10} />}
			{outcome && (
				<rect x="9" y="1" width="5" height="10" rx="2" className={OUTCOME_FILL[outcome]} />
			)}
		</svg>
	);
}
