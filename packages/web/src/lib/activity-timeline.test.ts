import {describe, expect, test} from 'bun:test';
import type {ActivityTask, AuditEntry} from '@/lib/types';
import {
	type LanePreferences,
	laneAssignments,
	lanesEverywhere,
	layActivityTimeline,
	prepareActivityTimeline,
	type Window,
} from './activity-timeline';

const now = new Date('2026-10-16T12:00:00Z');
const WIDTH = 600;
// The past six hours.
const window = {from: new Date('2026-10-16T06:00:00Z'), to: now};

function task(overrides: Partial<ActivityTask>): ActivityTask {
	return {
		id: 't1',
		agentId: 'a1',
		parentId: null,
		title: 'Triage inbox',
		goal: 'Archive the newsletters',
		via: 'mcp',
		startedAt: '2026-10-16T11:00:00Z',
		finishedAt: null,
		outcome: null,
		// Nothing done for it after it started, unless a test gives a time.
		lastActiveAt: overrides.startedAt ?? '2026-10-16T11:00:00Z',
		...overrides,
	};
}

function entry(overrides: Partial<AuditEntry>): AuditEntry {
	return {
		id: 'e1',
		at: '2026-10-16T11:01:00Z',
		agentId: 'a1',
		connectionId: 'mail-1',
		collectionId: 'emails',
		action: 'list',
		recordTitle: null,
		query: null,
		outcome: 'allowed',
		error: null,
		via: 'mcp',
		taskId: 't1',
		durationMs: 60_000,
		userId: null,
		userName: null,
		...overrides,
	};
}

// The tasks prepared and laid out over the window in one go, as the timeline does for each window.
function build(
	tasks: ActivityTask[],
	entries: AuditEntry[],
	at: Date,
	over: Window,
	width: number,
	preferred?: LanePreferences,
	held?: boolean,
) {
	return layActivityTimeline(
		prepareActivityTimeline(tasks, entries, at),
		over,
		width,
		preferred,
		held,
	);
}

describe('layActivityTimeline', () => {
	// Under way, a request made for it five minutes ago.
	const inbox = task({lastActiveAt: '2026-10-16T11:55:00Z'});
	const call = task({
		id: 't2',
		title: 'Prepare for the Acme call',
		startedAt: '2026-10-16T08:00:00Z',
		finishedAt: '2026-10-16T08:30:00Z',
	});
	const report = task({
		id: 't3',
		agentId: 'a2',
		title: 'Expense report',
		startedAt: '2026-10-16T09:00:00Z',
		finishedAt: '2026-10-16T10:00:00Z',
	});

	test('every agent’s row, those with a task under way first; tasks one after another share a lane, overlapping ones each take one', () => {
		const overlapping = task({
			id: 't4',
			startedAt: '2026-10-16T11:30:00Z',
			lastActiveAt: '2026-10-16T11:50:00Z',
		});
		const timeline = build([report, inbox, call, overlapping], [], now, window, WIDTH);
		expect(timeline.rows.map((row) => row.agentId)).toEqual(['a1', 'a2']);
		expect(timeline.rows[0]?.working).toBe(2);
		expect(timeline.rows[0]?.lanes.map((lane) => lane.map((bar) => bar.tasks[0]?.id))).toEqual([
			['t2', 't1'],
			['t4'],
		]);
		expect(timeline.rows[1]?.working).toBe(0);
	});

	test('places each bar in the window, running on past its end while under way', () => {
		const timeline = build([inbox, call], [], now, window, WIDTH);
		const bars = timeline.rows[0]?.lanes[0] ?? [];
		expect(bars.map((bar) => [bar.tasks[0]?.id, bar.start, bar.end, bar.status])).toEqual([
			['t2', 200, 250, 'finished'],
			['t1', 500, 600, 'running'],
		]);
		expect(bars[1]?.durationMs).toBe(60 * 60 * 1000);
		expect(bars[1]?.clippedEnd).toBe(false);
	});

	test('rolls a task’s sub-tasks into it, their requests on its bar, and counts them', () => {
		const sub = task({id: 'sub', parentId: 't1', startedAt: '2026-10-16T11:10:00Z'});
		const deeper = task({id: 'deeper', parentId: 'sub', startedAt: '2026-10-16T11:20:00Z'});
		const timeline = build(
			[inbox, sub, deeper],
			[entry({}), entry({id: 'e2', taskId: 'deeper', at: '2026-10-16T11:21:00Z'})],
			now,
			window,
			WIDTH,
		);
		const bars = timeline.rows.flatMap((row) => row.lanes.flat());
		expect(bars.map((bar) => bar.tasks[0]?.id)).toEqual(['t1']);
		expect(bars[0]?.subTasks).toBe(2);
		expect(bars[0]?.requests.map((request) => request.entry.id)).toEqual(['e1', 'e2']);
	});

	test('leaves out a task that ended before the window or started after it; one from before starts at its edge, clipped', () => {
		const old = task({
			id: 'old',
			startedAt: '2026-10-16T04:00:00Z',
			finishedAt: '2026-10-16T05:00:00Z',
		});
		const straddling = task({
			id: 'straddling',
			startedAt: '2026-10-16T05:00:00Z',
			finishedAt: '2026-10-16T07:00:00Z',
		});
		const timeline = build([old, straddling], [], now, window, WIDTH);
		const bars = timeline.rows.flatMap((row) => row.lanes.flat());
		expect(bars.map((bar) => [bar.tasks[0]?.id, bar.start, bar.end, bar.clippedStart])).toEqual([
			['straddling', 0, 100, true],
		]);
	});

	test('a task left open ends at its last request, not 20 minutes after it', () => {
		const stale = task({id: 'stale', startedAt: '2026-10-15T09:00:00Z'});
		const timeline = build(
			[stale],
			[entry({id: 'late', taskId: 'stale', at: '2026-10-16T07:00:00Z', durationMs: 0})],
			now,
			window,
			WIDTH,
		);
		const bar = timeline.rows[0]?.lanes[0]?.[0];
		expect(bar?.status).toBe('leftOpen');
		expect(bar?.members).toEqual([{start: 0, end: 100}]);
	});

	test('names every task’s lane under its own key and a cluster’s starting with it', () => {
		const burst = ['a', 'b'].map((id, index) =>
			task({
				id,
				startedAt: new Date(Date.parse('2026-10-16T09:00:00Z') + index * 1000).toISOString(),
				finishedAt: new Date(Date.parse('2026-10-16T09:00:10Z') + index * 1000).toISOString(),
			}),
		);
		const long = task({
			id: 'long',
			startedAt: '2026-10-16T08:59:00Z',
			finishedAt: '2026-10-16T09:30:00Z',
		});
		const timeline = build([long, ...burst], [], now, window, WIDTH);
		expect(laneAssignments(timeline)).toEqual(
			new Map([
				['long', 0],
				['cluster:a', 1],
			]),
		);
		expect(lanesEverywhere(timeline)).toEqual(
			new Map([
				['long', 0],
				['cluster:long', 0],
				['a', 1],
				['cluster:a', 1],
				['b', 1],
				['cluster:b', 1],
			]),
		);
	});

	test('counts every task under way in a bar of several, not the bar once', () => {
		// Three short tasks under way a few seconds apart, over a month, are one bar.
		const month = {from: new Date('2026-09-16T12:00:00Z'), to: now};
		const burst = ['a', 'b', 'c'].map((id, index) =>
			task({
				id,
				startedAt: new Date(Date.parse('2026-10-16T11:59:00Z') + index * 1000).toISOString(),
			}),
		);
		const timeline = build(burst, [], now, month, WIDTH);
		expect(timeline.rows[0]?.lanes.flat()).toHaveLength(1);
		expect(timeline.rows[0]?.working).toBe(3);
	});

	test('held to their lanes, overlapping bars share one rather than opening another', () => {
		const first = task({
			id: 'first',
			startedAt: '2026-10-16T10:00:00Z',
			finishedAt: '2026-10-16T11:30:00Z',
		});
		const second = task({
			id: 'second',
			startedAt: '2026-10-16T11:00:00Z',
			finishedAt: '2026-10-16T12:00:00Z',
		});
		const preferred = new Map([
			['first', 0],
			['second', 0],
		]);
		const apart = build([first, second], [], now, window, WIDTH, preferred);
		expect(apart.rows[0]?.lanes.map((lane) => lane.map((bar) => bar.tasks[0]?.id))).toEqual([
			['first'],
			['second'],
		]);
		const held = build([first, second], [], now, window, WIDTH, preferred, true);
		expect(held.rows[0]?.lanes.map((lane) => lane.map((bar) => bar.tasks[0]?.id))).toEqual([
			['first', 'second'],
		]);
		// One with no lane to keep joins the last lane rather than opening one.
		const third = task({
			id: 'third',
			startedAt: '2026-10-16T10:30:00Z',
			finishedAt: '2026-10-16T11:45:00Z',
		});
		const crowded = build([first, second, third], [], now, window, WIDTH, preferred, true);
		expect(crowded.rows[0]?.lanes.map((lane) => lane.map((bar) => bar.tasks[0]?.id))).toEqual([
			['first', 'third', 'second'],
		]);
	});

	test('short tasks close together are one bar, from the first to the last, with every request', () => {
		const burst = [0, 2, 4].map((minute) =>
			task({
				id: `b${minute}`,
				startedAt: `2026-10-16T10:0${minute}:00Z`,
				finishedAt: `2026-10-16T10:0${minute + 1}:00Z`,
			}),
		);
		const timeline = build(
			[...burst, call],
			burst.map((one) => entry({id: `e-${one.id}`, taskId: one.id, at: one.finishedAt ?? ''})),
			now,
			window,
			WIDTH,
		);
		const bars = timeline.rows[0]?.lanes.flat() ?? [];
		expect(bars.map((bar) => bar.tasks.map((one) => one.id))).toEqual([['t2'], ['b0', 'b2', 'b4']]);
		const cluster = bars[1];
		expect(cluster?.members).toHaveLength(3);
		expect(cluster?.fromMs).toBe(Date.parse('2026-10-16T10:00:00Z'));
		expect(cluster?.toMs).toBe(Date.parse('2026-10-16T10:05:00Z'));
		expect(cluster?.requests).toHaveLength(3);
		expect(cluster?.status).toBe('finished');
	});

	test('a bar keeps the lane it had where that is free, leaving a lane empty rather than hopping', () => {
		// Alone, the inbox takes the first lane; told it had the second, it keeps that.
		const first = build([inbox], [], now, window, WIDTH);
		expect(laneAssignments(first)).toEqual(new Map([['t1', 0]]));
		const kept = build([inbox], [], now, window, WIDTH, new Map([['t1', 1]]));
		expect(kept.rows[0]?.lanes.map((lane) => lane.map((bar) => bar.tasks[0]?.id))).toEqual([
			[],
			['t1'],
		]);
		// Another task that overlaps goes to the first lane that is free, the empty one.
		const overlapping = task({
			id: 't4',
			startedAt: '2026-10-16T11:30:00Z',
			lastActiveAt: '2026-10-16T11:50:00Z',
		});
		const both = build([inbox, overlapping], [], now, window, WIDTH, new Map([['t1', 1]]));
		expect(laneAssignments(both)).toEqual(
			new Map([
				['t1', 1],
				['t4', 0],
			]),
		);
		// A task new to the window, though it started earlier, doesn't take a kept lane.
		const earlier = task({
			id: 't5',
			startedAt: '2026-10-16T10:30:00Z',
			lastActiveAt: '2026-10-16T11:45:00Z',
		});
		const newcomer = build([inbox, earlier], [], now, window, WIDTH, new Map([['t1', 0]]));
		expect(laneAssignments(newcomer)).toEqual(
			new Map([
				['t1', 0],
				['t5', 1],
			]),
		);
		// Compacted, the empty lanes go.
		expect(laneAssignments(kept, true)).toEqual(new Map([['t1', 0]]));
		// A lane that is taken is not kept: the bar goes to the first free one instead.
		const clash = build(
			[inbox, overlapping],
			[],
			now,
			window,
			WIDTH,
			new Map([
				['t1', 0],
				['t4', 0],
			]),
		);
		expect(laneAssignments(clash)).toEqual(
			new Map([
				['t1', 0],
				['t4', 1],
			]),
		);
	});

	test('marks the axis in time before now, ending at it', () => {
		const timeline = build([inbox], [], now, window, WIDTH);
		expect(timeline.ticks.map((tick) => tick.label)).toEqual(['5h', '4h', '3h', '2h', '1h', 'Now']);
		expect(timeline.ticks.at(-1)?.px).toBe(WIDTH);
	});
});
