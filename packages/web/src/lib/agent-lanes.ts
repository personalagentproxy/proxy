import {taskEndedAt} from '@proxy/utils/tasks';
import type {ActivityLanes, LaneTask} from '@/client/schemas';
import type {AgentLogin} from '@/lib/types';

// The home page's lanes: one per agent, its tasks laid along the time up to now, so the person
// sees who is doing what for them. A task is a bar from when the agent started it to when it
// finished it, or gave it up, or to now while it is under way; it says which services it used and what was
// refused. Nothing here knows what a task depends on, only when it ran and what was done for it.

// The windows on offer, each a stretch of time ending now. Zooming goes between and beyond them.
export const WINDOWS = [
	{id: '1h', label: 'Last hour', minutes: 60},
	{id: '6h', label: 'Last 6 hours', minutes: 6 * 60},
	{id: '24h', label: 'Last 24 hours', minutes: 24 * 60},
] as const;

export type WindowId = (typeof WINDOWS)[number]['id'];

export const DEFAULT_MINUTES = 6 * 60;

// The least that is read, whatever the window, so zooming in has what it needs and the lanes
// know whether there is anything to show at all.
export const LOADED_MINUTES = 24 * 60;

// How far the window can be zoomed in and out: a quarter hour, and as far back as the api answers.
export const MIN_MINUTES = 15;
export const MAX_MINUTES = 31 * 24 * 60;

const MINUTE_MS = 60 * 1000;

/** The window on offer that is this long, if one is; zooming makes any other length. */
export function presetOf(minutes: number): WindowId | null {
	return WINDOWS.find((window) => window.minutes === minutes)?.id ?? null;
}

/** When a window this long starts: that much before `now`. */
export function windowStart(minutes: number, now: Date): Date {
	return new Date(now.getTime() - minutes * MINUTE_MS);
}

// How much the wheel zooms per pixel it reports: a few notches of a mouse wheel, or a short pinch
// on a trackpad, about doubles or halves the window.
const ZOOM_PER_PIXEL = 0.004;

/**
 * The window after a turn of the wheel: longer for scrolling down, shorter for up, by a factor so
 * zooming feels the same at every length, kept between the least and the most it can be.
 */
export function zoomed(minutes: number, deltaY: number): number {
	const next = minutes * Math.exp(deltaY * ZOOM_PER_PIXEL);
	return Math.round(Math.min(Math.max(next, MIN_MINUTES), MAX_MINUTES));
}

/** "Last 6 hours" for a window on offer; "Last 2h 15m" for one zoomed to. */
export function windowLabel(minutes: number): string {
	const preset = presetOf(minutes);
	if (preset) {
		return WINDOWS.find((window) => window.id === preset)?.label ?? '';
	}
	return `Last ${describeMinutes(minutes)}`;
}

// "45m", "2h 15m", "3d 4h".
function describeMinutes(minutes: number): string {
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
	}
	const days = Math.floor(hours / 24);
	return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

// A task is running until the agent calls it finished, or until a day after it started, when one
// never finished is taken as abandoned (@proxy/utils/tasks).
export type TaskStatus = 'running' | 'finished' | 'abandoned';

// When the task ended, if it has by `now`.
function endedAt(task: LaneTask, now: Date): Date | null {
	return taskEndedAt(
		{
			startedAt: new Date(task.startedAt),
			finishedAt: task.finishedAt === null ? null : new Date(task.finishedAt),
		},
		now,
	);
}

export function taskStatus(task: LaneTask, now: Date): TaskStatus {
	if (task.finishedAt !== null) {
		return 'finished';
	}
	return endedAt(task, now) === null ? 'running' : 'abandoned';
}

// The least of the lane a bar takes, so a task done in seconds is still there to see and open. A
// bar keeps its end where it is and grows back from it, so one still under way ends at now.
const MIN_WIDTH = 0.035;

export type PlacedTask = {
	task: LaneTask;
	status: TaskStatus;
	// Where the bar starts and how wide it is, as fractions of the window.
	left: number;
	width: number;
	// The task started before the window, so its bar starts at the edge.
	clipped: boolean;
};

/** Where a task sits in the window from `from` to `now`. */
export function placeTask(task: LaneTask, from: Date, now: Date): PlacedTask {
	const span = Math.max(now.getTime() - from.getTime(), 1);
	const startedAt = new Date(task.startedAt).getTime();
	const start = Math.max(startedAt, from.getTime());
	const end = Math.min(endedAt(task, now)?.getTime() ?? now.getTime(), now.getTime());
	const left = (start - from.getTime()) / span;
	const width = Math.max((end - start) / span, 0);
	return {task, status: taskStatus(task, now), left, width, clipped: startedAt < from.getTime()};
}

// Where a bar ends on the lane, and where it starts, its least width counted back from its end.
function endOf(placed: PlacedTask): number {
	return placed.left + placed.width;
}

function startOf(placed: PlacedTask): number {
	return endOf(placed) - Math.max(placed.width, MIN_WIDTH);
}

/**
 * The lane's tasks in rows, the earliest first, each task in the first row with room for it, so
 * tasks under way at once sit one under another rather than on top of each other.
 */
export function laneRows(placed: PlacedTask[]): PlacedTask[][] {
	const rows: PlacedTask[][] = [];
	for (const task of [...placed].sort((a, b) => a.left - b.left)) {
		const row = rows.find((candidate) => {
			const last = candidate.at(-1);
			return last === undefined || endOf(last) <= startOf(task);
		});
		if (row) {
			row.push(task);
			continue;
		}
		rows.push([task]);
	}
	return rows;
}

/**
 * How far into its sweep a task's shimmer starts, 0 to 1, from the task's id, so the bars don't
 * all sweep in step and a task keeps its own beat from one reading to the next.
 */
export function shimmerPhase(taskId: string): number {
	let hash = 0;
	for (const char of taskId) {
		hash = (hash * 31 + char.charCodeAt(0)) % 1000;
	}
	return hash / 1000;
}

export type LaneStatus = 'working' | 'idle';

export type Lane = {
	agentId: string;
	name: string;
	// Null for an agent that has been deleted.
	providerId: string | null;
	status: LaneStatus;
	// What was refused across the lane's tasks.
	denied: number;
	rows: PlacedTask[][];
};

function laneStatus(placed: PlacedTask[]): LaneStatus {
	return placed.some((task) => task.status === 'running') ? 'working' : 'idle';
}

const STATUS_ORDER: Record<LaneStatus, number> = {working: 0, idle: 1};

// When a lane last had something going on: the latest end of any of its bars, none as -1.
function lastActive(placed: PlacedTask[]): number {
	return placed.reduce((latest, task) => Math.max(latest, task.left + task.width), -1);
}

/**
 * A lane for every agent login that isn't revoked, idle ones included, and for any other agent
 * with a task in the window, which is `minutes` long and ends at the answer's now; the busiest
 * first, then those that did something most recently, then the idle ones by name.
 */
export function buildLanes(answer: ActivityLanes, minutes: number, agents: AgentLogin[]): Lane[] {
	const now = new Date(answer.now);
	const from = windowStart(minutes, now);
	const byAgent = new Map<string, PlacedTask[]>();
	for (const task of answer.tasks) {
		// A task that ended before the window has no place in it.
		const ended = endedAt(task, now);
		if (ended !== null && ended < from) {
			continue;
		}
		byAgent.set(task.agentId, [...(byAgent.get(task.agentId) ?? []), placeTask(task, from, now)]);
	}
	const ids = new Set([
		...agents.filter((agent) => agent.revokedAt === null).map((agent) => agent.id),
		...byAgent.keys(),
	]);
	return [...ids]
		.map((agentId) => {
			const agent = agents.find((candidate) => candidate.id === agentId);
			const placed = byAgent.get(agentId) ?? [];
			return {
				agentId,
				name: agent?.name ?? 'Deleted agent',
				providerId: agent?.providerId ?? null,
				status: laneStatus(placed),
				denied: placed.reduce((total, task) => total + task.task.denied, 0),
				rows: laneRows(placed),
			};
		})
		.sort(
			(a, b) =>
				STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
				lastActive(b.rows.flat()) - lastActive(a.rows.flat()) ||
				a.name.localeCompare(b.name),
		);
}

// The stretches of time a window is marked off in: the windows on offer each have their own, a
// quarter hour over an hour, an hour over six, three over a day; one zoomed to takes the largest
// that still gives it a few stretches.
const PRESET_STEPS: Record<WindowId, number> = {'1h': 15, '6h': 60, '24h': 3 * 60};
const STEPS = [5, 10, 15, 30, 60, 2 * 60, 3 * 60, 6 * 60, 12 * 60, 24 * 60, 7 * 24 * 60];
const MIN_STRETCHES = 5;

function stepOf(minutes: number): number {
	const preset = presetOf(minutes);
	if (preset) {
		return PRESET_STEPS[preset];
	}
	return (
		[...STEPS].reverse().find((candidate) => minutes / candidate >= MIN_STRETCHES) ??
		STEPS[0] ??
		minutes
	);
}

/** Where a window's lines fall, a step apart from its end, as fractions of it; none at either end. */
export function gridlines(minutes: number): number[] {
	const step = stepOf(minutes);
	const lines: number[] = [];
	for (let before = step; before < minutes; before += step) {
		lines.push(1 - before / minutes);
	}
	return lines.sort((a, b) => a - b);
}
