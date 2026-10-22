import {useCallback, useEffect, useRef, useState} from 'react';
import {Link} from 'react-router';
import {getActivityLanes} from '@/client/agents-client';
import type {ActivityLanes} from '@/client/schemas';
import {AgentLogo, IntegrationLogo} from '@/components/brand-logo';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';
import {
	buildLanes,
	DEFAULT_MINUTES,
	gridlines,
	LOADED_MINUTES,
	type Lane,
	type PlacedTask,
	presetOf,
	shimmerPhase,
	windowLabel,
	WINDOWS,
	windowStart,
	zoomed,
} from '@/lib/agent-lanes';
import {integrationOf} from '@/lib/integrations';
import type {AgentLogin, Connection} from '@/lib/types';
import {useOrgSlug} from '@/hooks/use-org';

// How often the lanes are read again while the page is open, so a task under way moves along.
const REFRESH_MS = 60 * 1000;

// At most this many services' logos in a bar.
const LOGOS = 3;

// How long one sweep of the shimmer takes, as index.css has it.
const SHIMMER_S = 2.4;

const LANE_LABEL = 'w-24 shrink-0 md:w-36';

// Zooming with the wheel is told to the api this long after the last turn.
const ZOOM_SETTLE_MS = 300;

const CUSTOM = 'custom';

// Under the home page's input: who is doing what for the person. A lane per agent, its tasks as
// bars along the window of time up to its right edge, now, each saying which services it used,
// with what was refused counted, and opening the task's requests in the activity log. The window
// is chosen above the lanes, or zoomed with Ctrl or Cmd and the wheel, or a pinch, as a video
// editor's timeline is, its end staying at now; zoomed to a length not on offer, the choice reads
// Custom. The lanes are read again every minute, always at least a day back. With no task in that
// much, there is nothing to show, and the lanes stay off the page.
export function AgentLanes({
	initial,
	agents,
	connections,
}: {
	initial: ActivityLanes;
	agents: AgentLogin[];
	connections: Connection[];
}) {
	const org = useOrgSlug();
	const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
	// The answer shown: the first came with the page. Zoomed out past what it covers, the older
	// part arrives with the next reading; zoomed in, it has everything already.
	const [answer, setAnswer] = useState(initial);
	const mounted = useRef(false);

	useEffect(() => {
		let gone = false;
		const read = async () => {
			const result = await getActivityLanes(
				org,
				windowStart(Math.max(minutes, LOADED_MINUTES), new Date()).toISOString(),
			);
			if (gone || result.isErr()) {
				return;
			}
			setAnswer(result.value);
		};
		// The page's own answer is fresh; a window chosen after it is read once it settles.
		const settle = mounted.current ? setTimeout(() => void read(), ZOOM_SETTLE_MS) : null;
		mounted.current = true;
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void read();
			}
		}, REFRESH_MS);
		return () => {
			gone = true;
			if (settle !== null) {
				clearTimeout(settle);
			}
			clearInterval(timer);
		};
	}, [org, minutes]);

	// The wheel with Ctrl or Cmd held, which a pinch on a trackpad also sends, zooms rather than
	// scrolls the page; listened to by hand, since React's wheel listener can't stop the scroll. On
	// the timeline whenever it is there, which it isn't while there is nothing to show.
	const listenForZoom = useCallback((element: HTMLDivElement) => {
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) {
				return;
			}
			event.preventDefault();
			setMinutes((current) => zoomed(current, event.deltaY));
		};
		element.addEventListener('wheel', onWheel, {passive: false});
		return () => element.removeEventListener('wheel', onWheel);
	}, []);

	// Nothing in the past day, or further back where the window reaches: nothing to show at all.
	if (answer.tasks.length === 0) {
		return null;
	}

	const lanes = buildLanes(answer, minutes, agents);
	const taskCount = lanes.reduce((total, lane) => total + lane.rows.flat().length, 0);
	const lines = gridlines(minutes);
	const preset = presetOf(minutes);

	return (
		<section aria-label="Agents" className="flex w-full max-w-3xl flex-col items-end gap-2 text-sm">
			<div className="flex items-center gap-3">
				<Select
					value={preset ?? CUSTOM}
					items={[
						...WINDOWS.map((window) => ({value: window.id, label: window.label})),
						{value: CUSTOM, label: windowLabel(minutes)},
					]}
					onValueChange={(next) => {
						const chosen = WINDOWS.find((window) => window.id === next);
						if (chosen) {
							setMinutes(chosen.minutes);
						}
					}}
				>
					<SelectTrigger size="sm" aria-label="Window" className="w-36">
						<SelectValue />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false}>
						{WINDOWS.map((window) => (
							<SelectItem key={window.id} value={window.id}>
								{window.label}
							</SelectItem>
						))}
						{preset === null && <SelectItem value={CUSTOM}>Custom</SelectItem>}
					</SelectContent>
				</Select>
			</div>
			<div
				ref={listenForZoom}
				className="w-full divide-y overflow-hidden rounded-xl border bg-card shadow-xs"
			>
				{lanes.map((lane) => (
					<LaneRow key={lane.agentId} lane={lane} lines={lines} connections={connections} />
				))}
				{taskCount === 0 && (
					<p className="px-4 py-3 text-center text-muted-foreground">
						No tasks in the {windowLabel(minutes).toLowerCase()}.
					</p>
				)}
			</div>
		</section>
	);
}

// One agent: who it is, in line with its first task and set off from the timeline beside it by
// a line and its own gray, then its tasks along the window, marked off in steps of time,
// those under way at once one under another.
function LaneRow({
	lane,
	lines,
	connections,
}: {
	lane: Lane;
	// Where the window's lines fall, as fractions of it.
	lines: number[];
	connections: Connection[];
}) {
	const rows = lane.rows.length > 0 ? lane.rows : [[]];
	return (
		<div className="flex">
			<div className={cn(LANE_LABEL, 'min-w-0 border-r bg-muted/40 px-3 py-1.5')}>
				<div className="flex h-8 items-center gap-2">
					{lane.providerId ? (
						<AgentLogo providerId={lane.providerId} />
					) : (
						<span className="size-5 shrink-0 rounded-md border border-dashed" />
					)}
					<span className="truncate font-medium">{lane.name}</span>
				</div>
			</div>
			<div className="relative min-w-0 flex-1 overflow-hidden py-1.5 pr-3">
				{lines.map((at) => (
					<span
						key={at}
						aria-hidden
						className="absolute inset-y-0 border-l border-border/60"
						style={{left: `${at * 100}%`}}
					/>
				))}
				{rows.map((row, index) => (
					<div key={index} className="relative h-8">
						{row.map((placed) => (
							<TaskBar key={placed.task.id} placed={placed} connections={connections} />
						))}
					</div>
				))}
			</div>
		</div>
	);
}

// Soft blue while a task is under way, gray once it is done or given up, and soft orange where a
// request was refused, which is the one that may need the person: the bar's fill, and its words.
const BAR_DONE = {fill: 'bg-muted/70 group-hover:bg-muted', text: 'text-muted-foreground'};

const BAR_STATUS: Record<PlacedTask['status'], {fill: string; text: string}> = {
	running: {
		fill: 'bg-sky-500/10 group-hover:bg-sky-500/15',
		text: 'text-sky-900 dark:text-sky-200',
	},
	finished: BAR_DONE,
	abandoned: BAR_DONE,
};

const BAR_BLOCKED = {
	fill: 'bg-amber-500/10 group-hover:bg-amber-500/15',
	text: 'text-amber-900 dark:text-amber-200',
};

// A task: where it ran, the services it used as a stack of logos, the most used first, its title, and what was
// refused, with a light sweeping along it while it is being worked on. Opens the task's requests
// in the activity log; its title and goal are in the tooltip.
function TaskBar({placed, connections}: {placed: PlacedTask; connections: Connection[]}) {
	const org = useOrgSlug();
	const {task, status} = placed;
	const colors = task.denied > 0 ? BAR_BLOCKED : BAR_STATUS[status];
	const logos = task.connectionIds
		.flatMap((connectionId) => {
			const connection = connections.find((candidate) => candidate.id === connectionId);
			const integration = connection && integrationOf(connection);
			return integration ? [{connectionId, integration}] : [];
		})
		.slice(0, LOGOS);

	return (
		// The tooltip never stands in the way: it can't be hovered itself, so moving on to the bar
		// above or below switches it to that one.
		<Tooltip disableHoverablePopup>
			<TooltipTrigger
				render={
					<Link
						to={`/${org}/activity?task=${encodeURIComponent(task.id)}`}
						// Anchored at its end, so a bar widened to its least width grows back from there
						// and one still under way ends at now, in line with the others.
						style={{
							right: `${(1 - placed.left - placed.width) * 100}%`,
							width: `${placed.width * 100}%`,
						}}
						className={cn(
							'group @container absolute inset-y-0.5 flex min-w-7 items-center whitespace-nowrap',
							colors.text,
						)}
					/>
				}
			>
				{/* The tint lies on the card's own color, so the lines behind don't show through. */}
				<span
					aria-hidden
					className={cn(
						'absolute inset-0 overflow-hidden rounded-md bg-card',
						placed.clipped && 'rounded-l-none',
					)}
				>
					<span className={cn('absolute inset-0 transition-colors', colors.fill)} />
					{status === 'running' && (
						<span
							// Each bar's sweep starts at a point of its own, so they don't all move in step.
							style={{animationDelay: `-${(shimmerPhase(task.id) * SHIMMER_S).toFixed(2)}s`}}
							className="absolute inset-0 animate-lanes-shimmer bg-linear-100 from-transparent from-30% via-white/60 via-50% to-transparent to-70% motion-reduce:hidden dark:via-white/10"
						/>
					)}
				</span>
				<span className="relative flex min-w-0 flex-1 items-center gap-1.5 px-2">
					{logos.length > 0 && (
						<span className="flex shrink-0 -space-x-1.5">
							{logos.map(({connectionId, integration}) => (
								<IntegrationLogo
									key={connectionId}
									integration={integration}
									// A bar at its least width has room for one logo only.
									className="size-4 rounded-sm ring-1 ring-background @max-[3rem]:not-first:hidden"
								/>
							))}
						</span>
					)}
					{/* The title goes in whenever a few letters fit, cut short as the bar allows; the tooltip has it whole. */}
					<span className="hidden min-w-0 flex-1 truncate @[3.5rem]:inline">{task.title}</span>
					{task.denied > 0 && (
						<span className="ml-auto hidden shrink-0 rounded-sm bg-amber-500/15 px-1 text-xs @[5rem]:inline">
							{task.denied} blocked
						</span>
					)}
				</span>
			</TooltipTrigger>
			<TooltipContent className="pointer-events-none max-w-xs">
				<span className="flex flex-col gap-0.5">
					<span className="font-medium">{task.title}</span>
					<span className="opacity-80">{task.goal}</span>
				</span>
			</TooltipContent>
		</Tooltip>
	);
}
