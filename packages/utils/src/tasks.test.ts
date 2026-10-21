import {describe, expect, test} from 'bun:test';

import {taskEndedAt} from './tasks';

const startedAt = new Date('2026-10-16T09:00:00Z');

describe('taskEndedAt', () => {
	test('is when the task was finished', () => {
		const finishedAt = new Date('2026-10-16T10:00:00Z');
		expect(taskEndedAt({startedAt, finishedAt}, new Date('2026-10-20T00:00:00Z'))).toEqual(
			finishedAt,
		);
	});

	test('is null for a task open less than a day', () => {
		expect(taskEndedAt({startedAt, finishedAt: null}, new Date('2026-10-17T08:59:59Z'))).toBeNull();
	});

	test('is a day after the start for a task never finished', () => {
		expect(taskEndedAt({startedAt, finishedAt: null}, new Date('2026-10-17T09:00:00Z'))).toEqual(
			new Date('2026-10-17T09:00:00Z'),
		);
		expect(taskEndedAt({startedAt, finishedAt: null}, new Date('2026-10-30T00:00:00Z'))).toEqual(
			new Date('2026-10-17T09:00:00Z'),
		);
	});
});
