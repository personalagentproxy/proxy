import {counted} from '@/lib/format';
import type {AuditEntry} from '@/lib/types';

// What the two timelines share: the task page's, of one run, and the home page's, of every agent
// over a window of time. Both lay out in pixels, measured from the chart's left edge, so that how
// wide a thing is drawn is a plain number: a request too short to see is still drawn two pixels
// wide, a task too short to name is grouped with its neighbors, and so on.

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

// A stretch of the chart, in pixels from its left edge.
export type Span = {start: number; end: number};

// A request, where it ran: from when it came in to when it was done, on the task it was made for.
export type TimelineRequest = Span & {entry: AuditEntry};

// The color tasks are drawn in, as a class setting the text color, which the charts' shapes take
// as currentColor: the reference palette's blue, stepped for the dark theme. Its orange, yellow
// and red are left out, as amber and red mean a request was blocked or failed.
export const TASK_COLOR_CLASS = 'text-[#2a78d6] dark:text-[#3987e5]';

// How faint a task's track is, and one given up.
export const TRACK_OPACITY = 0.2;
export const ABANDONED_OPACITY = 0.1;

// A track is drawn at least this wide, so a task done in a moment still reads as one.
export const MIN_TRACK_PX = 6;

/** "850ms", "1.2s", "5s", "12s", "2m 5s", "1h 4m", "2d 3h": how long something took, as short as it reads. */
export function formatDuration(ms: number): string {
	// Each unit is rounded to as a whole first, so it is split without carrying, as "1m 60s" would.
	if (Math.round(ms) < SECOND) {
		return `${Math.round(ms)}ms`;
	}
	const tenths = Math.round(ms / (SECOND / 10));
	if (tenths < 100) {
		return tenths % 10 === 0 ? `${tenths / 10}s` : `${(tenths / 10).toFixed(1)}s`;
	}
	const seconds = Math.round(ms / SECOND);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	if (seconds < 60 * 60) {
		return joined(Math.floor(seconds / 60), 'm', seconds % 60, 's');
	}
	const minutes = Math.round(ms / MINUTE);
	if (minutes < 48 * 60) {
		return joined(Math.floor(minutes / 60), 'h', minutes % 60, 'm');
	}
	const hours = Math.round(ms / HOUR);
	return joined(Math.floor(hours / 24), 'd', hours % 24, 'h');
}

// "2m 5s", or "2m" where there is none of the smaller unit.
function joined(large: number, largeUnit: string, small: number, smallUnit: string): string {
	return small === 0 ? `${large}${largeUnit}` : `${large}${largeUnit} ${small}${smallUnit}`;
}

/** "40s", "48m", "3h", "2d": about how long, in one unit, for where there is no room for more. */
export function roughDuration(ms: number): string {
	const seconds = Math.round(ms / SECOND);
	if (seconds < 60) {
		return `${Math.max(seconds, 1)}s`;
	}
	const minutes = Math.round(ms / MINUTE);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.round(ms / HOUR);
	if (hours < 48) {
		return `${hours}h`;
	}
	return `${Math.round(ms / (24 * HOUR))}d`;
}

/** The spans, sorted, with those that overlap or come within `gap` of one another made one. */
export function merged(spans: Span[], gap = 0): Span[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const out: Span[] = [];
	for (const span of sorted) {
		const last = out.at(-1);
		if (last && span.start <= last.end + gap) {
			last.end = Math.max(last.end, span.end);
			continue;
		}
		out.push({...span});
	}
	return out;
}

/** When a request ran, in milliseconds since the epoch: from when it came in to when it was logged, done. */
export function requestTimes(entry: AuditEntry): {from: number; to: number} {
	const to = new Date(entry.at).getTime();
	return {from: to - (entry.durationMs ?? 0), to};
}

/** "3 requests · 1 blocked · 2 failed": what was made for a task, where anything was. */
export function requestSummary(requests: TimelineRequest[]): string[] {
	return [
		...(requests.length > 0 ? [counted(requests.length, 'request')] : []),
		...outcomeSummary(requests.map((request) => request.entry)),
	];
}

/** "2 blocked · 1 failed": what of `entries` didn't go through, where anything didn't. */
export function outcomeSummary(entries: AuditEntry[]): string[] {
	const blocked = entries.filter((entry) => entry.outcome === 'denied').length;
	const failed = entries.filter((entry) => entry.outcome === 'failed').length;
	return [
		...(blocked > 0 ? [`${blocked} blocked`] : []),
		...(failed > 0 ? [`${failed} failed`] : []),
	];
}

// A request is drawn at least this wide, so one done in a moment still shows.
const MIN_REQUEST_PX = 2;

// A request with when it ran (requestTimes), read from it once.
export type TimedRequest = {entry: AuditEntry; from: number; to: number};

/** Each of `entries` with when it ran, for laying them out again and again without reading the times each time. */
export function timedRequests(entries: AuditEntry[]): TimedRequest[] {
	return entries.map((entry) => ({entry, ...requestTimes(entry)}));
}

/**
 * The requests of `entries` laid along the chart by `px`, which maps a time to pixels, those that
 * ran outside `from` and `to` left out, in the order they came in.
 */
export function layRequests(
	entries: AuditEntry[],
	px: (ms: number) => number,
	from: number,
	to: number,
): TimelineRequest[] {
	return layTimedRequests(timedRequests(entries), px, from, to);
}

/** The requests, with when each ran, laid along the chart as layRequests lays them. */
export function layTimedRequests(
	requests: TimedRequest[],
	px: (ms: number) => number,
	from: number,
	to: number,
): TimelineRequest[] {
	return requests
		.flatMap((ran) => {
			if (ran.to < from || ran.from > to) {
				return [];
			}
			const start = px(Math.max(ran.from, from));
			return [
				{entry: ran.entry, start, end: Math.max(px(Math.min(ran.to, to)), start + MIN_REQUEST_PX)},
			];
		})
		.sort((a, b) => a.start - b.start);
}

// The steps an axis is marked off in.
const STEPS = [1, 2, 5, 10, 15, 30]
	.map((s) => s * SECOND)
	.concat(
		[1, 2, 5, 10, 15, 30].map((m) => m * MINUTE),
		[1, 2, 3, 6, 12, 24].map((h) => h * HOUR),
		[2, 7, 14, 30].map((d) => d * 24 * HOUR),
	);

/** The least step that spaces marks at least `labelPx` apart over `ms` drawn `px` wide. */
export function stepFor(ms: number, px: number, labelPx: number): number {
	return STEPS.find((step) => (step / ms) * px >= labelPx) ?? STEPS[STEPS.length - 1] ?? ms;
}
