import {describe, expect, test} from 'bun:test';
import type {ActivitySummary} from '@/client/schemas';
import {agentName, daySpan, graphWeeks, summarizeWeek} from '@/lib/activity-graph';
import type {Connection} from '@/lib/types';

const connection = (id: string, integrationId: string, account: string): Connection => ({
	id,
	integrationId,
	account,
	defaults: [],
	tools: null,
	name: null,
	unavailable: [],
});

const connections = [
	connection('work', 'email', 'me@work.example'),
	connection('home', 'email', 'me@home.example'),
	connection('google', 'google', 'me@example.com'),
	{
		...connection('docs', 'mcp', 'docs.example.com/mcp'),
		name: 'Docs',
		tools: [{name: 'search_docs', title: 'Search docs', description: '', inputSchema: {}}],
	},
];

type WeekRow = ActivitySummary['week'][number];

const row = (
	connectionId: string,
	collectionId: string,
	action: string,
	count: number,
	outcome: WeekRow['outcome'] = 'allowed',
): WeekRow => ({connectionId, collectionId, action, outcome, count});

describe('summarizeWeek', () => {
	test('says what was written and sent before what was read, the same thing in two mailboxes once', () => {
		const week = summarizeWeek(
			[
				row('work', 'emails', 'view', 90),
				row('home', 'emails', 'view', 50),
				row('work', 'emails', 'list', 30),
				row('google', 'events', 'create', 3),
				row('work', 'emails', 'send', 2),
				row('home', 'emails', 'send', 4, 'denied'),
			],
			connections,
		);

		expect(week).toEqual({
			total: 179,
			denied: 4,
			done: ['Created 3 events', 'Sent 2 emails', 'Viewed 140 emails'],
		});
	});

	test('names a custom server’s tool, and a disconnected one’s by its name', () => {
		const week = summarizeWeek(
			[row('docs', 'tools', 'search_docs', 3), row('gone', 'tools', 'fetch_page', 1)],
			connections,
		);

		expect(week.done).toEqual(['Ran Search docs 3 times', 'Ran fetch_page once']);
	});

	test('keeps to the three most done', () => {
		const week = summarizeWeek(
			[
				row('work', 'emails', 'archive', 5),
				row('work', 'emails', 'markRead', 4),
				row('google', 'events', 'create', 3),
				row('google', 'contacts', 'update', 1),
			],
			connections,
		);

		expect(week.done).toHaveLength(3);
		expect(week.done[0]).toBe('Archived 5 emails');
	});
});

const summary = (today: string, days: ActivitySummary['days']): ActivitySummary => ({
	today,
	days,
	week: [],
});

describe('graphWeeks', () => {
	test('ends in this week, Monday first, the days after today empty', () => {
		// A Friday.
		const weeks = graphWeeks(summary('2026-10-16', []), 2);

		expect(weeks).toHaveLength(2);
		expect(weeks[0]?.[0]?.day).toBe('2026-10-05');
		expect(weeks[1]?.[0]?.day).toBe('2026-10-12');
		expect(weeks[1]?.[4]?.day).toBe('2026-10-16');
		expect(weeks[1]?.[5]).toBeNull();
		expect(weeks[1]?.[6]).toBeNull();
	});

	test('adds up each day’s agents, the most first, and shades it among the busy days', () => {
		const weeks = graphWeeks(
			summary('2026-10-16', [
				{day: '2026-10-12', agentId: 'a1', count: 1, denied: 0},
				{day: '2026-10-13', agentId: 'a1', count: 2, denied: 0},
				{day: '2026-10-14', agentId: null, count: 4, denied: 0},
				{day: '2026-10-14', agentId: 'a1', count: 6, denied: 2},
				{day: '2026-10-15', agentId: 'a1', count: 40, denied: 0},
			]),
			1,
		);
		const [week] = weeks;

		expect(week?.[2]).toEqual({
			day: '2026-10-14',
			count: 10,
			denied: 2,
			agents: [
				{agentId: 'a1', count: 6},
				{agentId: null, count: 4},
			],
			level: 3,
		});
		expect(week?.map((cell) => cell?.level)).toEqual([1, 2, 3, 4, 0, undefined, undefined]);
	});
});

describe('the rest', () => {
	test('the person’s own requests are theirs, and a deleted agent says so', () => {
		expect(agentName(null, [])).toBe('You');
		expect(agentName('gone', [])).toBe('Deleted agent');
	});

	test('a day spans midnight to midnight on the browser’s clock', () => {
		const span = daySpan('2026-10-14');

		expect(span?.from).toBe(new Date(2026, 9, 14).toISOString());
		expect(span?.to).toBe(new Date(2026, 9, 15).toISOString());
		expect(daySpan('yesterday')).toBeNull();
		expect(daySpan('2026-13-45')).toBeNull();
	});
});
