import {
	formatDuration,
	layTimedRequests,
	MINUTE,
	type Span,
	type TimedRequest,
	timedRequests,
	type TimelineRequest,
} from '@/lib/timeline';
import {
	combinedStatus,
	endsOf,
	gridlines,
	type TaskStatus,
	taskStatus,
} from '@/lib/timeline-window';
import type {ActivityTask, AuditEntry} from '@/lib/types';

// The home page's timeline: who is doing what. Every agent has a row over a window of time
// ending now, or scrolled back from it, and in it a bar for every task it was given, with the
// requests made for the task along the bottom of the bar as long as each took. A task's sub-tasks
// are rolled into it here, their requests on its bar; the task's page lays them out. Tasks under
// way at once each take a lane of the agent's row; one after another, they share one. Over a long
// window, short tasks close together are one bar, which zooms the window in on them. A bar keeps
// the lane it had the last time, where that is free, so bars don't hop lanes as others come and
// go; a lane left empty that way stays until the window comes to rest.

export type ActivityBar = Span & {
	// The task, or, for short ones close together, the tasks, in the order started.
	tasks: ActivityTask[];
	// Where each task runs.
	members: Span[];
	// The task's, or, for several, under way if any is, else abandoned if every one was.
	status: TaskStatus;
	// From when the first started to when the last ended, or to now, in milliseconds since the epoch.
	fromMs: number;
	toMs: number;
	durationMs: number;
	// It started before the window, or runs on past its end.
	clippedStart: boolean;
	clippedEnd: boolean;
	// Made for its tasks, or for a task rolled into one of them.
	requests: TimelineRequest[];
	// How many tasks were handed on from its tasks, at any depth.
	subTasks: number;
};

export type ActivityRow = {
	agentId: string;
	// Bars in lanes: those in one lane don't overlap. A lane may be empty, where the bars that kept
	// it have left.
	lanes: ActivityBar[][];
	working: number;
};

// The lane each bar, by its key, had the last time: what it is given again where that is free.
export type LanePreferences = ReadonlyMap<string, number>;

type ActivityTick = {px: number; label: string};

export type ActivityTimeline = {rows: ActivityRow[]; width: number; ticks: ActivityTick[]};

export type Window = {from: Date; to: Date};

// The least room between two tasks in one lane, in pixels, so their bars don't touch.
const LANE_GAP_PX = 6;

// A task drawn narrower than this is short; short tasks of one agent less than the gap apart
// are one bar, since a bar each would hold nothing readable. That bar is at least wide enough
// to say how many it holds.
const SHORT_PX = 28;
const CLUSTER_GAP_PX = 16;
const CLUSTER_MIN_PX = 52;

// The room a gridline's label takes, "23h 30m" with space around it.
const LABEL_PX = 72;

// A task an agent was given itself, with what it handed on rolled in: what doesn't change as the
// window moves, worked out once for every window the timeline is laid out over.
type RolledTask = {
	task: ActivityTask;
	status: TaskStatus;
	fromMs: number;
	toMs: number;
	requests: TimedRequest[];
	subTasks: number;
};

// The tasks of a timeline as they stood at `now`, ready to be laid out over any window.
type ActivityTasks = {now: Date; rolled: RolledTask[]};

/** `tasks` and the requests made for them as they stood at `now`, each task with its sub-tasks rolled in. */
export function prepareActivityTimeline(
	allTasks: ActivityTask[],
	entries: AuditEntry[],
	now: Date,
): ActivityTasks {
	const ofTask = new Map<string, AuditEntry[]>();
	for (const entry of entries) {
		if (entry.taskId === null) {
			continue;
		}
		const own = ofTask.get(entry.taskId);
		if (own) {
			own.push(entry);
			continue;
		}
		ofTask.set(entry.taskId, [entry]);
	}
	// A task's end takes in its sub-tasks', so a task of its own's is its whole tree's.
	const ends = endsOf(allTasks, entries, now);
	const ids = new Set(allTasks.map((task) => task.id));
	// The tasks agents were given themselves, each with what it handed on rolled in.
	const tops = allTasks.filter((task) => task.parentId === null || !ids.has(task.parentId));
	const children = new Map<string, ActivityTask[]>();
	for (const task of allTasks) {
		if (task.parentId === null) {
			continue;
		}
		const siblings = children.get(task.parentId);
		if (siblings) {
			siblings.push(task);
			continue;
		}
		children.set(task.parentId, [task]);
	}
	const descendants = (task: ActivityTask): ActivityTask[] =>
		(children.get(task.id) ?? []).flatMap((child) => [child, ...descendants(child)]);
	const rolled = tops.map((task): RolledTask => {
		const tree = [task, ...descendants(task)];
		return {
			task,
			status: taskStatus(task, now),
			fromMs: new Date(task.startedAt).getTime(),
			toMs: (ends.get(task.id) ?? now).getTime(),
			requests: timedRequests(tree.flatMap((one) => ofTask.get(one.id) ?? [])),
			subTasks: tree.length - 1,
		};
	});
	return {now, rolled};
}

/**
 * The timeline of the tasks prepared once (prepareActivityTimeline) over `window`, `width` pixels
 * wide, as they stood at their `now`: every agent's row, the busiest first, over the tasks it was
 * given that were under way in the window, each bar in the lane `preferred` gives it where that is
 * free, else the first that is. With `held`, a bar
 * keeps the lane `preferred` gives it even where another bar is there, the two overlapping, and no
 * lane is opened for one with no lane to keep: for the moment the view is zooming in on a bar, so
 * bars part along the way rather than hop lanes or open ones empty again at the end.
 */
export function layActivityTimeline(
	{now, rolled}: ActivityTasks,
	window: Window,
	width: number,
	preferred: LanePreferences = new Map(),
	held = false,
): ActivityTimeline {
	const from = window.from.getTime();
	const to = window.to.getTime();
	const spanMs = Math.max(to - from, 1);
	const px = (ms: number) => ((Math.min(Math.max(ms, from), to) - from) / spanMs) * width;
	const bars = rolled
		.filter((one) => one.fromMs <= to && one.toMs >= from)
		.map((one): ActivityBar => {
			const span = {start: px(one.fromMs), end: px(one.toMs)};
			return {
				tasks: [one.task],
				members: [span],
				status: one.status,
				...span,
				fromMs: one.fromMs,
				toMs: one.toMs,
				durationMs: one.toMs - one.fromMs,
				clippedStart: one.fromMs < from,
				clippedEnd: one.toMs > to,
				requests: layTimedRequests(one.requests, px, from, to),
				subTasks: one.subTasks,
			};
		})
		.sort((a, b) => a.fromMs - b.fromMs);
	const agentIds = [...new Set(bars.map((bar) => bar.tasks[0]?.agentId ?? ''))];
	const rows = agentIds.map((agentId): ActivityRow => {
		const own = clustered(
			bars.filter((bar) => bar.tasks[0]?.agentId === agentId),
			width,
		);
		const lanes: ActivityBar[][] = [];
		const free = (lane: ActivityBar[] | undefined, bar: ActivityBar) =>
			lane === undefined ||
			lane.every(
				(other) => other.end + LANE_GAP_PX <= bar.start || bar.end + LANE_GAP_PX <= other.start,
			);
		// Bars with a lane to keep take it first, so a bar new to the window can't take it from them,
		// whether or not it is free while the view is zooming; then every other bar takes the first
		// lane that is free.
		const place = (bar: ActivityBar, index: number) => {
			while (lanes.length <= index) {
				lanes.push([]);
			}
			lanes[index]?.push(bar);
		};
		const rest: ActivityBar[] = [];
		for (const bar of own) {
			const wanted = laneWanted(bar, preferred);
			if (wanted !== undefined && (held || free(lanes[wanted], bar))) {
				place(bar, wanted);
				continue;
			}
			rest.push(bar);
		}
		for (const bar of rest) {
			const first = lanes.findIndex((lane) => free(lane, bar));
			if (first !== -1) {
				place(bar, first);
				continue;
			}
			place(bar, held ? Math.max(lanes.length - 1, 0) : lanes.length);
		}
		for (const lane of lanes) {
			lane.sort((a, b) => a.start - b.start);
		}
		// Tasks, not bars: a bar of several may hold more than one under way.
		const working = own
			.flatMap((bar) => bar.tasks)
			.filter((task) => taskStatus(task, now) === 'running').length;
		return {agentId, lanes, working};
	});
	const lastEnd = (row: ActivityRow) => Math.max(...row.lanes.flat().map((bar) => bar.end));
	rows.sort(
		(a, b) =>
			Number(b.working > 0) - Number(a.working > 0) ||
			lastEnd(b) - lastEnd(a) ||
			a.agentId.localeCompare(b.agentId),
	);
	const ticks = gridlines(
		spanMs / MINUTE,
		(now.getTime() - to) / MINUTE,
		Math.max(Math.floor(width / LABEL_PX), 2),
	).map(({at, ago}) => ({px: at * width, label: ago === 0 ? 'Now' : formatDuration(ago * MINUTE)}));
	return {rows, width, ticks};
}

/** A bar's key: its task's id, or, for several tasks, `cluster:` and the first's. */
export function keyOf(bar: ActivityBar): string {
	const id = bar.tasks[0]?.id ?? '';
	return bar.tasks.length > 1 ? `cluster:${id}` : id;
}

// The lane a bar had: its own, or, for a bar of several tasks newly together, its first task's,
// and for a task newly on its own, the lane of the bar it was first in.
function laneWanted(bar: ActivityBar, preferred: LanePreferences): number | undefined {
	const id = bar.tasks[0]?.id ?? '';
	return preferred.get(keyOf(bar)) ?? preferred.get(bar.tasks.length > 1 ? id : `cluster:${id}`);
}

/**
 * The lane every task of the timeline is in, under every key a bar for it could carry: its own,
 * and `cluster:` and its id, so that however the tasks fall into bars as the view zooms, each bar
 * finds the lane its tasks end up in.
 */
export function lanesEverywhere(timeline: ActivityTimeline): Map<string, number> {
	const lanes = new Map<string, number>();
	for (const row of timeline.rows) {
		row.lanes.forEach((lane, index) => {
			for (const bar of lane) {
				for (const task of bar.tasks) {
					lanes.set(task.id, index);
					lanes.set(`cluster:${task.id}`, index);
				}
			}
		});
	}
	return lanes;
}

/** The lane every bar of the timeline is in, by its key: what each is given again next time. */
export function laneAssignments(timeline: ActivityTimeline, compact = false): Map<string, number> {
	const assignments = new Map<string, number>();
	for (const row of timeline.rows) {
		const lanes = compact ? row.lanes.filter((lane) => lane.length > 0) : row.lanes;
		lanes.forEach((lane, index) => {
			for (const bar of lane) {
				assignments.set(keyOf(bar), index);
			}
		});
	}
	return assignments;
}

// One agent's bars, in the order started, with runs of short ones less than the gap apart made
// one bar each, wide enough to be named and kept inside the chart.
function clustered(bars: ActivityBar[], width: number): ActivityBar[] {
	const short = (bar: ActivityBar) => bar.end - bar.start < SHORT_PX;
	const out: ActivityBar[] = [];
	for (const bar of bars) {
		const last = out[out.length - 1];
		if (
			!last ||
			!short(bar) ||
			!last.members.every((member) => member.end - member.start < SHORT_PX) ||
			bar.start - last.end >= CLUSTER_GAP_PX
		) {
			out.push(bar);
			continue;
		}
		const tasks = [...last.tasks, ...bar.tasks];
		const members = [...last.members, ...bar.members];
		const start = Math.min(...members.map((member) => member.start), width - CLUSTER_MIN_PX);
		out[out.length - 1] = {
			tasks,
			members,
			status: combinedStatus([last.status, bar.status]),
			start,
			end: Math.max(...members.map((member) => member.end), start + CLUSTER_MIN_PX),
			fromMs: Math.min(last.fromMs, bar.fromMs),
			toMs: Math.max(last.toMs, bar.toMs),
			durationMs: Math.max(last.toMs, bar.toMs) - Math.min(last.fromMs, bar.fromMs),
			clippedStart: last.clippedStart || bar.clippedStart,
			clippedEnd: last.clippedEnd || bar.clippedEnd,
			requests: [...last.requests, ...bar.requests].sort((a, b) => a.start - b.start),
			subTasks: last.subTasks + bar.subTasks,
		};
	}
	return out;
}
