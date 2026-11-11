/// <reference types="bun" />

import type {ChatEntry} from '@proxy/contracts/harness';
import {describe, expect, test} from 'bun:test';
import {chatRuns, conversationSide, formatSectionTime} from '@/lib/chat-runs';

// A moment in the browser's own time zone, as the page counts days in it.
function at(month: number, day: number, hour: number, minute = 0, year = 2026): string {
	return new Date(year, month - 1, day, hour, minute).toISOString();
}

function entry(id: string, kind: 'person' | 'assistant', when: string): ChatEntry {
	return {id, kind, text: id, isError: false, at: when};
}

// A task the persona started, as the conversation shows it.
function task(id: string, when: string): ChatEntry {
	return {id, kind: 'task', task: {id, title: id}, at: when};
}

const now = new Date(2026, 9, 21, 15, 0);

describe('formatSectionTime', () => {
	test('names today and yesterday, with the time', () => {
		expect(formatSectionTime(at(10, 21, 9, 5), now)).toBe('Today 9:05 AM');
		expect(formatSectionTime(at(10, 20, 23, 30), now)).toBe('Yesterday 11:30 PM');
	});

	test('gives an earlier day with its weekday, and the year once it is not this one', () => {
		expect(formatSectionTime(at(9, 26, 3), now)).toBe('Sat, Sep 26 3:00 AM');
		expect(formatSectionTime(at(12, 31, 18, 0, 2025), now)).toBe('Wed, Dec 31, 2025 6:00 PM');
	});
});

describe('chatRuns', () => {
	test('heads the first turn and keeps turns from the same side together', () => {
		const runs = chatRuns(
			[
				entry('a', 'person', at(10, 21, 10, 0)),
				entry('b', 'assistant', at(10, 21, 10, 1)),
				entry('c', 'assistant', at(10, 21, 10, 2)),
			],
			now,
			conversationSide,
		);
		expect(runs.map((run) => [run.heading, run.entries.map((turn) => turn.id)])).toEqual([
			['Today 10:00 AM', ['a']],
			[null, ['b', 'c']],
		]);
	});

	test('starts a new stretch after an hour’s pause, even from the same side', () => {
		const runs = chatRuns(
			[
				entry('a', 'assistant', at(10, 21, 10, 0)),
				entry('b', 'assistant', at(10, 21, 10, 59)),
				entry('c', 'assistant', at(10, 21, 12, 0)),
			],
			now,
			conversationSide,
		);
		expect(runs.map((run) => [run.heading, run.entries.map((turn) => turn.id)])).toEqual([
			['Today 10:00 AM', ['a', 'b']],
			['Today 12:00 PM', ['c']],
		]);
	});

	test('starts a new stretch on another day, however short the pause', () => {
		const runs = chatRuns(
			[entry('a', 'person', at(10, 20, 23, 50)), entry('b', 'assistant', at(10, 21, 0, 5))],
			now,
			conversationSide,
		);
		expect(runs.map((run) => run.heading)).toEqual(['Yesterday 11:50 PM', 'Today 12:05 AM']);
	});

	test('keeps the tasks the persona started on its side, with its answers', () => {
		const runs = chatRuns(
			[
				entry('a', 'person', at(10, 21, 10, 0)),
				entry('b', 'assistant', at(10, 21, 10, 1)),
				task('t', at(10, 21, 10, 1)),
				entry('c', 'person', at(10, 21, 10, 2)),
			],
			now,
			conversationSide,
		);
		expect(runs.map((run) => run.entries.map((turn) => turn.id))).toEqual([
			['a'],
			['b', 't'],
			['c'],
		]);
	});

	test('lays out nothing for an empty conversation', () => {
		expect(chatRuns([], now, conversationSide)).toEqual([]);
	});
});
