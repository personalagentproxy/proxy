import {describe, expect, test} from 'bun:test';
import {HOUR, MINUTE, SECOND} from '@/lib/timeline';
import type {ActivityTask, AuditEntry} from '@/lib/types';
import {
	BREAK_PX,
	buildAxis,
	buildRunTimeline,
	defaultExpanded,
	folded,
	groupId,
} from './run-timeline';

const now = new Date('2026-10-16T09:10:00Z');
const WIDTH = 600;

function task(overrides: Partial<ActivityTask>): ActivityTask {
	return {
		id: 'plan',
		agentId: 'a1',
		parentId: null,
		title: 'Plan the week',
		goal: 'List the week’s events and what to do first',
		via: 'mcp',
		startedAt: '2026-10-16T09:00:00Z',
		finishedAt: null,
		outcome: null,
		// Nothing done for it after it started, unless a test gives a time.
		lastActiveAt: overrides.startedAt ?? '2026-10-16T09:00:00Z',
		...overrides,
	};
}

function entry(overrides: Partial<AuditEntry>): AuditEntry {
	return {
		id: 'e1',
		at: '2026-10-16T09:01:00Z',
		agentId: 'a1',
		connectionId: 'mail-1',
		collectionId: 'emails',
		action: 'list',
		recordTitle: null,
		query: null,
		outcome: 'allowed',
		error: null,
		via: 'mcp',
		taskId: 'plan',
		durationMs: 0,
		userId: null,
		userName: null,
		...overrides,
	};
}

describe('buildAxis', () => {
	test('moments a few milliseconds apart are not spread across the width', () => {
		// Tasks starting at 0s, 1s, 1.01s and 10s, and nothing taking any time.
		const axis = buildAxis(
			10 * SECOND,
			[0, 1000, 1010, 10 * SECOND].map((at) => ({start: at, end: at})),
			800,
		);
		expect(axis.px(1010) - axis.px(1000)).toBeLessThan(20);
	});

	test('with something happening throughout, is linear and marked a round step apart', () => {
		const axis = buildAxis(100 * SECOND, [{start: 0, end: 100 * SECOND}], WIDTH);
		expect(axis.breaks).toEqual([]);
		expect(axis.px(50 * SECOND)).toBe(WIDTH / 2);
		expect(axis.px(-5)).toBe(0);
		expect(axis.px(200 * SECOND)).toBe(WIDTH);
		expect(axis.ticks.map((tick) => tick.label)).toEqual([
			'0s',
			'15s',
			'30s',
			'45s',
			'1m',
			'1m 15s',
			'1m 30s',
		]);
	});

	test('folds a long idle stretch to a break, and marks either side of it, not under its label', () => {
		const axis = buildAxis(
			10 * HOUR,
			[
				{start: 0, end: 10 * MINUTE},
				{start: 9 * HOUR + 50 * MINUTE, end: 10 * HOUR},
			],
			WIDTH,
		);
		expect(axis.breaks).toHaveLength(1);
		const [gap] = axis.breaks;
		if (!gap) {
			throw new Error('no break');
		}
		expect(gap.end - gap.start).toBeCloseTo(BREAK_PX);
		expect(gap.idleMs).toBeGreaterThan(9 * HOUR);
		// The busy stretches share the rest of the width evenly, each running on a few pixels past
		// its last moment before the break, which holds what lies between.
		expect(axis.px(10 * MINUTE)).toBeCloseTo((WIDTH - BREAK_PX) / 2 - 8, 0);
		expect(axis.px(5 * HOUR)).toBeGreaterThan(gap.start);
		expect(axis.px(5 * HOUR)).toBeLessThan(gap.end);
		expect(axis.px(10 * HOUR)).toBe(WIDTH);
		const labels = axis.ticks.map((tick) => tick.label);
		expect(labels[0]).toBe('0s');
		expect(labels).toContain('5m');
		expect(labels).toContain('10h');
		expect(labels).not.toContain('9h 50m');
		for (const tick of axis.ticks) {
			expect(tick.px < gap.start - 40 || tick.px > gap.end + 40).toBe(true);
		}
	});

	test('with next to nothing between two idle stretches, folds only the longer', () => {
		const axis = buildAxis(
			10 * HOUR,
			[
				{start: 0, end: 10 * MINUTE},
				{start: 4 * HOUR, end: 4 * HOUR},
				{start: 9 * HOUR + 50 * MINUTE, end: 10 * HOUR},
			],
			WIDTH,
		);
		expect(axis.breaks).toHaveLength(1);
		expect(axis.breaks[0]?.idleMs).toBeGreaterThan(5 * HOUR);
	});

	test('leaves a short idle stretch as it is', () => {
		const axis = buildAxis(
			10 * MINUTE,
			[
				{start: 0, end: 4 * MINUTE},
				{start: 5 * MINUTE, end: 10 * MINUTE},
			],
			WIDTH,
		);
		expect(axis.breaks).toEqual([]);
	});
});

describe('defaultExpanded', () => {
	test('lays out what the tasks at the top handed on, and rolls in the rest', () => {
		const tasks = [
			task({id: 'top'}),
			task({id: 'mid', parentId: 'top'}),
			task({id: 'low', parentId: 'mid'}),
			task({id: 'other', parentId: 'elsewhere'}),
		];
		expect([...defaultExpanded(tasks)].sort()).toEqual(['other', 'top']);
	});
});

describe('buildRunTimeline', () => {
	const plan = task({finishedAt: '2026-10-16T09:10:00Z', outcome: 'Tuesday is the day to start'});
	const calendar = task({
		id: 'calendar',
		parentId: 'plan',
		title: 'Check the calendar',
		startedAt: '2026-10-16T09:01:00Z',
		finishedAt: '2026-10-16T09:04:00Z',
		outcome: 'Tuesday afternoon is free',
	});
	const issues = task({
		id: 'issues',
		parentId: 'plan',
		title: 'Find the open issues',
		startedAt: '2026-10-16T09:03:00Z',
		finishedAt: '2026-10-16T09:06:00Z',
		outcome: 'Six issues open',
	});
	const notes = task({
		id: 'notes',
		parentId: 'calendar',
		title: 'Pull the meeting notes',
		startedAt: '2026-10-16T09:02:00Z',
		finishedAt: '2026-10-16T09:03:00Z',
		outcome: 'Three decisions',
	});
	// Requests every minute or so, so nothing in the ten minutes is idle enough to fold.
	const steady = [5, 6, 7, 8, 9].map((minute) =>
		entry({id: `s${minute}`, at: `2026-10-16T09:0${minute}:00Z`}),
	);
	const rowsOf = (tasks: ActivityTask[], options?: Parameters<typeof buildRunTimeline>[4]) =>
		buildRunTimeline(tasks, steady, now, WIDTH, options).rows;

	test('every task has a row under the one it was handed from, in the order started, a step further in', () => {
		const rows = rowsOf([plan, issues, calendar, notes], {expanded: new Set(['plan', 'calendar'])});
		expect(rows.map((row) => [row.id, row.depth, row.parentRow])).toEqual([
			['plan', 0, null],
			['calendar', 1, 0],
			['notes', 2, 1],
			['issues', 1, 0],
		]);
	});

	test('lays the tasks along one axis from when the first started, a track as long as each ran', () => {
		const timeline = buildRunTimeline([plan, calendar, issues, notes], steady, now, WIDTH, {
			expanded: new Set(['plan', 'calendar']),
		});
		expect(timeline.breaks).toEqual([]);
		expect(timeline.spanMs).toBe(10 * MINUTE);
		const calendarRow = timeline.rows.find((row) => row.id === 'calendar');
		expect(calendarRow?.start).toBeCloseTo(60);
		expect(calendarRow?.end).toBeCloseTo(240);
		expect(calendarRow?.durationMs).toBe(3 * MINUTE);
		// The top task waited while its sub-tasks were under way, the two overlapping as one stretch.
		expect(timeline.rows[0]?.waiting).toEqual([{start: 60, end: 360}]);
		expect(timeline.ticks.map((tick) => tick.label)).toEqual(['0s', '2m', '4m', '6m', '8m', '10m']);
	});

	test('a task’s sub-tasks are rolled into it unless it is expanded, their requests on its track', () => {
		const entries = [
			...steady,
			entry({id: 'c1', taskId: 'calendar', at: '2026-10-16T09:01:30Z'}),
			entry({id: 'n1', taskId: 'notes', at: '2026-10-16T09:02:30Z'}),
		];
		const folded = buildRunTimeline([plan, calendar, notes], entries, now, WIDTH, {
			expanded: new Set(['plan']),
		}).rows;
		expect(folded.map((row) => row.id)).toEqual(['plan', 'calendar']);
		expect(folded[1]?.rolledIn).toBe(1);
		expect(folded[1]?.requests.map((request) => request.entry.id)).toEqual(['c1', 'n1']);
		expect(folded[1]?.waiting).toEqual([]);
		const open = buildRunTimeline([plan, calendar, notes], entries, now, WIDTH, {
			expanded: new Set(['plan', 'calendar']),
		}).rows;
		expect(open.map((row) => row.id)).toEqual(['plan', 'calendar', 'notes']);
		expect(open[1]?.rolledIn).toBe(0);
		expect(open[1]?.requests.map((request) => request.entry.id)).toEqual(['c1']);
		expect(open[1]?.waiting).toEqual([{start: 120, end: 180}]);
	});

	test('a task finished by its agent is handed back; one finished along with its parent, saying nothing, is not', () => {
		const quiet = task({
			id: 'quiet',
			parentId: 'plan',
			startedAt: '2026-10-16T09:05:00Z',
			finishedAt: '2026-10-16T09:10:00Z',
		});
		const rows = rowsOf([plan, calendar, quiet], {expanded: new Set(['plan'])});
		expect(rows.map((row) => [row.id, row.handedBack])).toEqual([
			['plan', true],
			['calendar', true],
			['quiet', false],
		]);
	});

	test('short tasks one after another share a row until it is opened', () => {
		const parent = task({id: 'parent', finishedAt: '2026-10-16T09:05:00Z', outcome: 'Done'});
		const burst = ['a', 'b', 'c'].map((id, index) =>
			task({
				id,
				parentId: 'parent',
				startedAt: new Date(Date.parse('2026-10-16T09:01:00Z') + index * 15 * SECOND).toISOString(),
				finishedAt: new Date(
					Date.parse('2026-10-16T09:01:10Z') + index * 15 * SECOND,
				).toISOString(),
				outcome: 'Found it',
			}),
		);
		const entries = [1, 2, 3, 4].map((minute) =>
			entry({id: `p${minute}`, taskId: 'parent', at: `2026-10-16T09:0${minute}:00Z`}),
		);
		const together = buildRunTimeline([parent, ...burst], entries, now, WIDTH, {
			expanded: new Set(['parent']),
		}).rows;
		expect(together.map((row) => [row.kind, row.id, row.depth, row.parentRow])).toEqual([
			['task', 'parent', 0, null],
			['group', groupId(burst), 1, 0],
		]);
		const group = together[1];
		expect(group?.tasks.map((member) => member.id)).toEqual(['a', 'b', 'c']);
		expect(group?.members).toHaveLength(3);
		expect(group?.rolledIn).toBe(3);
		expect(group?.handedBack).toBe(true);
		expect(group?.durationMs).toBe(40 * SECOND);
		expect(together[0]?.waiting).toEqual([{start: group?.start ?? 0, end: group?.end ?? 0}]);

		const apart = buildRunTimeline([parent, ...burst], entries, now, WIDTH, {
			expanded: new Set(['parent', groupId(burst)]),
		}).rows;
		expect(apart.map((row) => row.id)).toEqual(['parent', 'a', 'b', 'c']);

		// Folding the parent puts the group back together for when it is opened again.
		const again = buildRunTimeline([parent, ...burst], entries, now, WIDTH, {
			expanded: new Set([
				...folded(new Set(['parent', groupId(burst)]), [parent, ...burst], 'parent'),
				'parent',
			]),
		}).rows;
		expect(again.map((row) => row.id)).toEqual(['parent', groupId(burst)]);
	});

	test('a group of tasks left open is not handed back', () => {
		const parent = task({
			id: 'parent',
			startedAt: '2026-10-14T09:00:00Z',
			lastActiveAt: '2026-10-14T09:02:00Z',
		});
		const burst = ['a', 'b'].map((id, index) =>
			task({
				id,
				parentId: 'parent',
				startedAt: new Date(Date.parse('2026-10-14T09:01:00Z') + index * 3 * SECOND).toISOString(),
			}),
		);
		// The parent busy throughout, so nothing is folded and the two are close together.
		const entries = [
			entry({id: 'p1', taskId: 'parent', at: '2026-10-14T09:05:00Z', durationMs: 5 * MINUTE}),
		];
		const rows = buildRunTimeline([parent, ...burst], entries, now, WIDTH, {
			expanded: new Set(['parent']),
		}).rows;
		const group = rows.find((row) => row.kind === 'group');
		expect(group?.status).toBe('leftOpen');
		expect(group?.handedBack).toBe(false);
	});

	test('a task still under way runs to the end of the axis, which is now', () => {
		const open = task({id: 'open', startedAt: '2026-10-16T09:05:00Z'});
		const timeline = buildRunTimeline([plan, open], steady, now, WIDTH);
		expect(timeline.spanMs).toBe(10 * MINUTE);
		const row = timeline.rows.find((candidate) => candidate.id === 'open');
		expect(row?.status).toBe('running');
		expect(row?.end).toBe(WIDTH);
		expect(row?.durationMs).toBe(5 * MINUTE);
	});

	test('a task left open runs until the last thing done for it or what it handed on', () => {
		const parent = task({
			id: 'parent',
			startedAt: '2026-10-15T07:00:00Z',
			lastActiveAt: '2026-10-15T08:00:00Z',
		});
		const sub = task({id: 'sub', parentId: 'parent', startedAt: '2026-10-15T08:00:00Z'});
		const timeline = buildRunTimeline(
			[parent, sub],
			[
				entry({id: 'own', taskId: 'parent', at: '2026-10-15T07:10:00Z'}),
				entry({id: 'handed', taskId: 'sub', at: '2026-10-15T08:30:00Z'}),
			],
			now,
			WIDTH,
		);
		const row = timeline.rows.find((candidate) => candidate.id === 'parent');
		expect(row?.status).toBe('leftOpen');
		expect(row?.durationMs).toBe(90 * MINUTE);
		expect(row?.end).toBe(WIDTH);
	});

	test('with nothing under way, the axis ends at the last thing done', () => {
		const late = entry({id: 'late', at: '2026-10-16T09:08:00Z'});
		const timeline = buildRunTimeline(
			[task({finishedAt: '2026-10-16T09:02:00Z', outcome: 'Done'})],
			[entry({id: 'e0', at: '2026-10-16T09:01:00Z'}), late],
			now,
			WIDTH,
		);
		expect(timeline.spanMs).toBe(8 * MINUTE);
	});

	test('a run done in a moment still gets ten seconds of axis, and no tasks no rows', () => {
		const quick = task({finishedAt: '2026-10-16T09:00:01Z', outcome: 'Done'});
		expect(buildRunTimeline([quick], [], now, WIDTH).spanMs).toBe(10 * SECOND);
		expect(buildRunTimeline([], [], now, WIDTH).rows).toEqual([]);
	});
});
