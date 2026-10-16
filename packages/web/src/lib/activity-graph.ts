import {addDays, daysBetween, weekdayOf} from '@proxy/utils/days';
import type {ActivitySummary} from '@/client/schemas';
import {describeCount, locateEntry, type LocatedEntry} from '@/lib/access';
import type {AgentLogin, Connection} from '@/lib/types';

// The home page's graph of what agents did: a column per week, Monday at the top, each day's
// requests, darker the more there were, on the browser's clock.

// The time zone the graph counts days in.
export function browserTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// A day on the browser's clock as the activity log narrows to it: from its midnight until the
// next one, which a change of clocks makes 23 or 25 hours later.
export function daySpan(day: string): {from: string; to: string} | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
		return null;
	}
	// A date and a time without an offset is read on the browser's clock.
	const from = new Date(`${day}T00:00`);
	if (Number.isNaN(from.getTime())) {
		return null;
	}
	const to = new Date(`${addDays(day, 1)}T00:00`);
	return {from: from.toISOString(), to: to.toISOString()};
}

// "Wed, Oct 14", with the year once it is not this year's.
export function formatDay(day: string): string {
	const date = new Date(`${day}T00:00`);
	return date.toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
	});
}

export type GraphDay = {
	day: string;
	count: number;
	denied: number;
	// Each agent's requests, the most first; a null agent is Personal Agent Proxy's own.
	agents: Array<{agentId: string | null; count: number}>;
	// 0 for none, then 1 to 4 by the quarter of the busy days' counts it falls in.
	level: 0 | 1 | 2 | 3 | 4;
};

// Where a count sits among the busy days': in their lowest quarter, the next, and so on, so a
// heavy day doesn't wash out every other.
function levelOf(count: number, sorted: number[]): GraphDay['level'] {
	if (count === 0) {
		return 0;
	}
	const quantile = (q: number) => sorted[Math.floor(q * (sorted.length - 1))] ?? 0;
	if (count <= quantile(0.25)) {
		return 1;
	}
	if (count <= quantile(0.5)) {
		return 2;
	}
	return count <= quantile(0.75) ? 3 : 4;
}

// The weeks ending in today's, oldest first, each Monday to Sunday; the days after today are null.
export function graphWeeks(summary: ActivitySummary, weeks: number): Array<Array<GraphDay | null>> {
	const start = addDays(summary.today, -weekdayOf(summary.today) - 7 * (weeks - 1));
	const byDay = new Map<string, Omit<GraphDay, 'level'>>();
	for (const row of summary.days) {
		if (daysBetween(start, row.day) < 0) {
			continue;
		}
		const known = byDay.get(row.day) ?? {day: row.day, count: 0, denied: 0, agents: []};
		known.count += row.count;
		known.denied += row.denied;
		known.agents.push({agentId: row.agentId, count: row.count});
		byDay.set(row.day, known);
	}
	const sorted = [...byDay.values()].map((day) => day.count).sort((a, b) => a - b);

	return Array.from({length: weeks}, (_, week) =>
		Array.from({length: 7}, (_, weekday) => {
			const day = addDays(start, week * 7 + weekday);
			if (daysBetween(summary.today, day) > 0) {
				return null;
			}
			const counted = byDay.get(day) ?? {day, count: 0, denied: 0, agents: []};
			const agents = [...counted.agents].sort((a, b) => b.count - a.count);
			return {...counted, agents, level: levelOf(counted.count, sorted)};
		}),
	);
}

// What a day's line names an agent: Personal Agent Proxy's own is the person's.
export function agentName(agentId: string | null, agents: AgentLogin[]): string {
	if (agentId === null) {
		return 'You';
	}
	return agents.find((agent) => agent.id === agentId)?.name ?? 'Deleted agent';
}

export type WeekSummary = {
	total: number;
	denied: number;
	// The most done, at most three, in the activity log's words: what was written or sent first,
	// then what was read.
	done: string[];
};

const SHOWN = 3;

// The past week in a line: how many requests, what they did, and how many were refused.
export function summarizeWeek(
	week: ActivitySummary['week'],
	connections: Connection[],
): WeekSummary {
	// The same thing done to two connections, as viewing emails in two mailboxes, is one count.
	const kinds = new Map<
		string,
		{row: ActivitySummary['week'][number]; located: LocatedEntry | null; count: number}
	>();
	for (const row of week) {
		if (row.outcome === 'denied') {
			continue;
		}
		const located = locateEntry(connections, row);
		const key = describeCount(row, 1, located);
		if (key === null) {
			continue;
		}
		const known = kinds.get(key);
		if (known) {
			known.count += row.count;
			continue;
		}
		kinds.set(key, {row, located, count: row.count});
	}

	const done = [...kinds.values()]
		.sort(
			(a, b) =>
				Number(a.row.action === 'view') - Number(b.row.action === 'view') || b.count - a.count,
		)
		.slice(0, SHOWN)
		.flatMap(({row, located, count}) => describeCount(row, count, located) ?? []);
	const sum = (rows: ActivitySummary['week']) => rows.reduce((total, row) => total + row.count, 0);
	return {
		total: sum(week),
		denied: sum(week.filter((row) => row.outcome === 'denied')),
		done,
	};
}
