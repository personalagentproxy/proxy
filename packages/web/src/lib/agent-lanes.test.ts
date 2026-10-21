import {describe, expect, test} from 'bun:test';
import type {ActivityLanes, LaneTask} from '@/client/schemas';
import type {AgentLogin} from '@/lib/types';
import {
	buildLanes,
	gridlines,
	laneRows,
	placeTask,
	presetOf,
	shimmerPhase,
	taskStatus,
	windowLabel,
	windowStart,
	zoomed,
} from './agent-lanes';

const now = new Date('2026-10-16T12:00:00Z');
const from = new Date('2026-10-16T11:00:00Z');

function task(overrides: Partial<LaneTask>): LaneTask {
	return {
		id: 't1',
		agentId: 'a1',
		title: 'Triage inbox',
		goal: 'Archive the newsletters',
		via: 'mcp',
		startedAt: '2026-10-16T11:30:00Z',
		finishedAt: null,
		requests: 3,
		denied: 0,
		connectionIds: ['mail-1'],
		...overrides,
	};
}

function agent(id: string, name: string, revokedAt: string | null = null): AgentLogin {
	return {
		id,
		providerId: 'claude',
		name,
		username: id,
		createdAt: '2026-10-01T00:00:00.000Z',
		lastActiveAt: null,
		revokedAt,
		grants: [],
	};
}

describe('taskStatus', () => {
	test('a task is running until it is finished, or a day after it started, abandoned', () => {
		expect(taskStatus(task({}), now)).toBe('running');
		expect(taskStatus(task({finishedAt: '2026-10-16T11:58:00Z'}), now)).toBe('finished');
		expect(taskStatus(task({startedAt: '2026-10-15T12:00:01Z'}), now)).toBe('running');
		expect(taskStatus(task({startedAt: '2026-10-15T12:00:00Z'}), now)).toBe('abandoned');
	});
});

describe('shimmerPhase', () => {
	test('is a fraction of the sweep, the same for an id each time and different between ids', () => {
		const phase = shimmerPhase('task-1');

		expect(phase).toBeGreaterThanOrEqual(0);
		expect(phase).toBeLessThan(1);
		expect(shimmerPhase('task-1')).toBe(phase);
		expect(shimmerPhase('task-2')).not.toBe(phase);
	});
});

describe('placeTask', () => {
	test('a task sits where it ran in the window, an open one reaching now, one from before the window cut at its edge', () => {
		const open = placeTask(task({}), from, now);
		const done = placeTask(task({finishedAt: '2026-10-16T11:45:00Z'}), from, now);
		const early = placeTask(
			task({startedAt: '2026-10-16T10:00:00Z', finishedAt: '2026-10-16T11:15:00Z'}),
			from,
			now,
		);

		expect(open).toMatchObject({left: 0.5, width: 0.5, clipped: false, status: 'running'});
		expect(done).toMatchObject({left: 0.5, width: 0.25, status: 'finished'});
		expect(early).toMatchObject({left: 0, width: 0.25, clipped: true});
	});

	test('a task never finished ends a day after it started', () => {
		const abandoned = placeTask(task({startedAt: '2026-10-15T11:30:00Z'}), from, now);

		expect(abandoned).toMatchObject({left: 0, width: 0.5, clipped: true, status: 'abandoned'});
	});
});

describe('laneRows', () => {
	test('tasks under way at once go one under another; one after another share a row', () => {
		const first = placeTask(
			task({id: 'a', startedAt: '2026-10-16T11:00:00Z', finishedAt: '2026-10-16T11:20:00Z'}),
			from,
			now,
		);
		const overlapping = placeTask(
			task({id: 'b', startedAt: '2026-10-16T11:10:00Z', finishedAt: '2026-10-16T11:40:00Z'}),
			from,
			now,
		);
		const later = placeTask(task({id: 'c', startedAt: '2026-10-16T11:30:00Z'}), from, now);

		expect(
			laneRows([later, overlapping, first]).map((row) => row.map((placed) => placed.task.id)),
		).toEqual([['a', 'c'], ['b']]);
	});

	test('a task done in a moment still takes its least width, counted back from its end', () => {
		const long = placeTask(
			task({id: 'a', startedAt: '2026-10-16T11:00:00Z', finishedAt: '2026-10-16T11:20:00Z'}),
			from,
			now,
		);
		const quickAfter = placeTask(
			task({id: 'b', startedAt: '2026-10-16T11:20:30Z', finishedAt: '2026-10-16T11:20:35Z'}),
			from,
			now,
		);
		const quickLater = placeTask(
			task({id: 'c', startedAt: '2026-10-16T11:30:00Z', finishedAt: '2026-10-16T11:30:05Z'}),
			from,
			now,
		);

		expect(laneRows([long, quickAfter])).toHaveLength(2);
		expect(laneRows([long, quickLater])).toHaveLength(1);
	});
});

describe('buildLanes', () => {
	const answer: ActivityLanes = {
		now: now.toISOString(),
		from: from.toISOString(),
		tasks: [
			task({id: 't1', agentId: 'a1', denied: 2}),
			task({id: 't2', agentId: 'a2', finishedAt: '2026-10-16T11:50:00Z'}),
			task({id: 't3', agentId: 'gone'}),
			// Abandoned before the window: no part of it.
			task({id: 't4', agentId: 'a3', startedAt: '2026-10-15T10:00:00Z'}),
		],
	};

	test('a lane per login that isn’t revoked, idle ones too, and for any other agent with a task; the working first, the idle last', () => {
		const lanes = buildLanes(answer, 60, [
			agent('a1', 'Claude'),
			agent('a2', 'ChatGPT'),
			agent('a3', 'Poke'),
			agent('a4', 'Old', '2026-10-10T00:00:00Z'),
		]);

		expect(
			lanes.map((lane) => [lane.name, lane.status, lane.denied, lane.rows.flat().length]),
		).toEqual([
			['Claude', 'working', 2, 1],
			['Deleted agent', 'working', 0, 1],
			['ChatGPT', 'idle', 0, 1],
			['Poke', 'idle', 0, 0],
		]);
	});
});

describe('the window', () => {
	test('starts its length before now', () => {
		expect(windowStart(60, now)).toEqual(from);
	});

	test('is marked off in its own step on offer, else the largest that leaves a few stretches', () => {
		expect(gridlines(60)).toEqual([0.25, 0.5, 0.75]);
		expect(gridlines(6 * 60)).toHaveLength(5);
		expect(gridlines(24 * 60)).toHaveLength(7);
		expect(gridlines(135)).toHaveLength(8);
		expect(gridlines(25 * 60)).toHaveLength(8);
	});

	test('zooms by the wheel, out for down and in for up, within its bounds', () => {
		expect(zoomed(360, 200)).toBeGreaterThan(360);
		expect(zoomed(360, -200)).toBeLessThan(360);
		expect(zoomed(20, -5000)).toBe(15);
		expect(zoomed(20000, 5000)).toBe(31 * 24 * 60);
	});

	test('is one on offer at its lengths, and named by its length otherwise', () => {
		expect(presetOf(360)).toBe('6h');
		expect(presetOf(135)).toBeNull();
		expect(windowLabel(360)).toBe('Last 6 hours');
		expect(windowLabel(135)).toBe('Last 2h 15m');
		expect(windowLabel(45)).toBe('Last 45m');
		expect(windowLabel(3 * 24 * 60)).toBe('Last 3d');
	});
});
