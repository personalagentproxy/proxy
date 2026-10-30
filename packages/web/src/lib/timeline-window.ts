import type {ActivityTask, AuditEntry} from '@proxy/contracts/activity';
import {taskEndedAt} from '@proxy/utils/tasks';
import {requestTimes} from '@/lib/timeline';

// The home page's timeline looks back over a window of time ending now, chosen from a few on offer
// or zoomed to any length; and a task, there and on its page, is under way, finished or left open.

// The windows on offer, each a stretch of time ending now. Zooming goes between and beyond them.
export const WINDOWS = [
	{id: '1h', label: 'Last hour', minutes: 60},
	{id: '6h', label: 'Last 6 hours', minutes: 6 * 60},
	{id: '24h', label: 'Last 24 hours', minutes: 24 * 60},
] as const;

type WindowId = (typeof WINDOWS)[number]['id'];

export const DEFAULT_MINUTES = 24 * 60;

// The least that is read, whatever the window, so zooming in has what it needs and the timeline
// knows whether there is anything to show at all.
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
 * zooming feels the same at every length, kept between the least and the most it can be. Not
 * rounded to whole minutes, so the small turns a pinch sends add up rather than each rounding back
 * to where it started; it is rounded once the wheel rests.
 */
export function zoomed(minutes: number, deltaY: number): number {
	const next = minutes * Math.exp(deltaY * ZOOM_PER_PIXEL);
	return Math.min(Math.max(next, MIN_MINUTES), MAX_MINUTES);
}

// Zoomed in on a stretch of time, the window is this much longer than it, so it isn't up against
// either edge.
const ZOOM_ROOM = 1.25;

/**
 * How long the window is, in milliseconds, zoomed in on the stretch from `from` to `to`: a little
 * longer than it, kept between the least and the most it can be. Zoomed in on a stretch already
 * shorter than the least, it is the least, which may be no shorter than the window was.
 */
export function zoomedOn(from: number, to: number): number {
	const width = (to - from) * ZOOM_ROOM;
	return Math.min(Math.max(width, MIN_MINUTES * MINUTE_MS), MAX_MINUTES * MINUTE_MS);
}

/**
 * "Last 6 hours" for a window on offer, "Last 2h 15m" for one zoomed to; scrolled back from now,
 * when it isn't the last anything, just "6 hours" or "2h 15m".
 */
export function windowLabel(minutes: number, endsNow = true): string {
	const preset = presetOf(minutes);
	const label = preset
		? (WINDOWS.find((window) => window.id === preset)?.label ?? '')
		: `Last ${describeMinutes(minutes)}`;
	return endsNow ? label : label.replace(/^Last /, '');
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

// A task is running until the agent calls it finished, or until 20 minutes after anything was last
// done for it or its sub-tasks, when one never finished is taken as left open (@proxy/utils/tasks).
export type TaskStatus = 'running' | 'finished' | 'leftOpen';

export const STATUS_LABEL: Record<TaskStatus, string> = {
	running: 'Under way',
	finished: 'Finished',
	leftOpen: 'Left open',
};

// When it started, when anything was last done for it or its sub-tasks and when it was finished,
// all a task's status needs.
type TaskTimes = Pick<ActivityTask, 'startedAt' | 'lastActiveAt' | 'finishedAt'>;

// When the task was taken as left open, if it has been by `now`: 20 minutes after anything was
// last done for it or its sub-tasks, never finished (@proxy/utils/tasks); null while it is under
// way, or where it was finished.
function leftOpenAt(task: TaskTimes, now: Date): Date | null {
	if (task.finishedAt !== null) {
		return null;
	}
	return taskEndedAt({lastActiveAt: new Date(task.lastActiveAt), finishedAt: null}, now);
}

// A task with what it was handed on from, all its end needs.
type TaskInTree = TaskTimes & Pick<ActivityTask, 'id' | 'parentId'>;

/**
 * When each of `tasks` ended, if it has by `now`: when it was finished; or, left open, when
 * anything was last done for it or its sub-tasks (`lastActiveAt`), or the last of `entries` made
 * for it was done or the last of its sub-tasks ended where that is later, as it can be by the
 * minute `lastActiveAt` is written at most once in (db/task's touchAgentTask). Null while it is
 * under way.
 */
export function endsOf(
	tasks: TaskInTree[],
	entries: AuditEntry[],
	now: Date,
): Map<string, Date | null> {
	const lastRequest = new Map<string, number>();
	for (const entry of entries) {
		if (entry.taskId === null) {
			continue;
		}
		const done = requestTimes(entry).to;
		lastRequest.set(entry.taskId, Math.max(lastRequest.get(entry.taskId) ?? done, done));
	}
	const children = new Map<string, TaskInTree[]>();
	for (const task of tasks) {
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
	const ends = new Map<string, Date | null>();
	const endOf = (task: TaskInTree): Date | null => {
		if (ends.has(task.id)) {
			return ends.get(task.id) ?? null;
		}
		const end = ownEnd(task);
		ends.set(task.id, end);
		return end;
	};
	const ownEnd = (task: TaskInTree): Date | null => {
		if (task.finishedAt !== null) {
			return new Date(task.finishedAt);
		}
		if (leftOpenAt(task, now) === null) {
			return null;
		}
		const active = new Date(task.lastActiveAt).getTime();
		// A sub-task is left open no later than its parent (@proxy/utils/tasks), so each has ended.
		return new Date(
			Math.max(
				active,
				lastRequest.get(task.id) ?? active,
				...(children.get(task.id) ?? []).map((child) => endOf(child)?.getTime() ?? active),
			),
		);
	};
	for (const task of tasks) {
		endOf(task);
	}
	return ends;
}

export function taskStatus(task: TaskTimes, now: Date): TaskStatus {
	if (task.finishedAt !== null) {
		return 'finished';
	}
	return leftOpenAt(task, now) === null ? 'running' : 'leftOpen';
}

/** The status of several tasks drawn as one: under way if any is, else left open if every one was. */
export function combinedStatus(statuses: TaskStatus[]): TaskStatus {
	if (statuses.includes('running')) {
		return 'running';
	}
	return statuses.every((status) => status === 'leftOpen') ? 'leftOpen' : 'finished';
}

// The stretches of time a window is marked off in: the windows on offer each have their own, a
// quarter hour over an hour, an hour over six, three over a day; one zoomed to takes the largest
// that still gives it a few stretches.
const PRESET_STEPS: Record<WindowId, number> = {'1h': 15, '6h': 60, '24h': 3 * 60};
const STEPS = [
	5,
	10,
	15,
	30,
	60,
	2 * 60,
	3 * 60,
	6 * 60,
	12 * 60,
	24 * 60,
	2 * 24 * 60,
	3 * 24 * 60,
	7 * 24 * 60,
];
const MIN_STRETCHES = 5;

// The window's own step, or, where that would give it more lines than there is room to label, the
// least step that gives no more than `maxLines`, but never one longer than half the window, so
// there is always a line or two to read it by.
function stepOf(minutes: number, maxLines: number): number {
	const preset = presetOf(minutes);
	const own = preset
		? PRESET_STEPS[preset]
		: ([...STEPS].reverse().find((candidate) => minutes / candidate >= MIN_STRETCHES) ??
			STEPS[0] ??
			minutes);
	if (minutes / own <= maxLines) {
		return own;
	}
	const fewer = STEPS.find((candidate) => minutes / candidate <= maxLines) ?? minutes;
	if (fewer <= minutes / 2) {
		return fewer;
	}
	return [...STEPS].reverse().find((candidate) => candidate <= minutes / 2) ?? own;
}

/**
 * Where a window `minutes` long, ending `endsAgo` minutes before now, has its lines: a whole number
 * of steps before now, each as a fraction of the window and how many minutes before now it is; one
 * at its end where that is on a step, as now is, and none at its start; no more than `maxLines`.
 */
export function gridlines(
	minutes: number,
	endsAgo = 0,
	maxLines = Number.POSITIVE_INFINITY,
): Array<{at: number; ago: number}> {
	const step = stepOf(minutes, maxLines);
	const lines: Array<{at: number; ago: number}> = [];
	for (let ago = Math.ceil(endsAgo / step) * step; ago < endsAgo + minutes; ago += step) {
		lines.push({at: 1 - (ago - endsAgo) / minutes, ago});
	}
	return lines.sort((a, b) => a.at - b.at);
}
