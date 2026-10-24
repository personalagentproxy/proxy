import {describe, expect, test} from 'bun:test';
import type {AuditEntry} from '@/lib/types';
import {
	formatDuration,
	layRequests,
	merged,
	MINUTE,
	requestSummary,
	roughDuration,
	SECOND,
	stepFor,
} from './timeline';

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
		durationMs: 1200,
		userId: null,
		userName: null,
		...overrides,
	};
}

describe('formatDuration', () => {
	test('reads as short as it can at every length', () => {
		expect(
			[850, 1200, 12_400, 125_000, 120_000, 3_840_000, 7_200_000, 50 * 3_600_000].map(
				formatDuration,
			),
		).toEqual(['850ms', '1.2s', '12s', '2m 5s', '2m', '1h 4m', '2h', '2d 2h']);
	});

	test('rounds up into the next unit, not to sixty of the one before', () => {
		expect(
			[
				999.6,
				9_960,
				59_600,
				119_600,
				3_599_700,
				7_170_000,
				47.999 * 3_600_000,
				71.9 * 3_600_000,
			].map(formatDuration),
		).toEqual(['1s', '10s', '1m', '2m', '1h', '2h', '2d', '3d']);
	});
});

describe('roughDuration', () => {
	test('gives one unit, about right', () => {
		expect(
			[400, 40 * SECOND, 47.6 * MINUTE, 23.9 * 60 * MINUTE, 72 * 60 * MINUTE].map(roughDuration),
		).toEqual(['1s', '40s', '48m', '24h', '3d']);
	});

	test('rounds up into the next unit', () => {
		expect([59.6 * SECOND, 59.6 * MINUTE, 47.6 * 60 * MINUTE].map(roughDuration)).toEqual([
			'1m',
			'1h',
			'2d',
		]);
	});
});

describe('merged', () => {
	test('makes spans that overlap, touch or come within the gap one, in order', () => {
		expect(
			merged([
				{start: 50, end: 60},
				{start: 10, end: 30},
				{start: 20, end: 40},
				{start: 40, end: 45},
			]),
		).toEqual([
			{start: 10, end: 45},
			{start: 50, end: 60},
		]);
		expect(
			merged(
				[
					{start: 0, end: 10},
					{start: 11, end: 12},
				],
				1,
			),
		).toEqual([{start: 0, end: 12}]);
	});
});

describe('stepFor', () => {
	test('is the least round step that leaves a label’s room between marks', () => {
		// Ten minutes over 600 pixels, 72 to a label: a step of at least 72 seconds, so two minutes.
		expect(stepFor(10 * MINUTE, 600, 72)).toBe(2 * MINUTE);
		expect(stepFor(30 * SECOND, 600, 72)).toBe(5 * SECOND);
	});
});

describe('layRequests', () => {
	const px = (ms: number) => (ms - Date.parse('2026-10-16T09:00:00Z')) / 1000;

	test('runs each from when it came in to when it was done, at least two pixels, in order, those outside left out', () => {
		const laid = layRequests(
			[
				entry({id: 'late', at: '2026-10-16T09:00:30Z', durationMs: 10_000}),
				entry({id: 'early', at: '2026-10-16T09:00:10Z', durationMs: null}),
				entry({id: 'gone', at: '2026-10-16T08:59:00Z', durationMs: 1000}),
			],
			px,
			Date.parse('2026-10-16T09:00:00Z'),
			Date.parse('2026-10-16T09:01:00Z'),
		);
		expect(laid.map((request) => [request.entry.id, request.start, request.end])).toEqual([
			['early', 10, 12],
			['late', 20, 30],
		]);
	});
});

describe('requestSummary', () => {
	test('counts the requests, and those blocked or failed where there were any', () => {
		const requests = [
			{start: 0, end: 1, entry: entry({})},
			{start: 0, end: 1, entry: entry({outcome: 'denied'})},
			{start: 0, end: 1, entry: entry({outcome: 'failed'})},
		];
		expect(requestSummary(requests)).toEqual(['3 requests', '1 blocked', '1 failed']);
		expect(requestSummary([])).toEqual([]);
		expect(requestSummary([{start: 0, end: 1, entry: entry({})}])).toEqual(['1 request']);
	});
});
