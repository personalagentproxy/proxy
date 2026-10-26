import {describe, expect, test} from 'bun:test';

import {taskEndedAt} from './tasks';

const lastActiveAt = new Date('2026-10-16T09:00:00Z');

describe('taskEndedAt', () => {
	test('is when the task was finished', () => {
		const finishedAt = new Date('2026-10-16T10:00:00Z');
		expect(taskEndedAt({lastActiveAt, finishedAt}, new Date('2026-10-20T00:00:00Z'))).toEqual(
			finishedAt,
		);
	});

	test('is null for a task open less than 20 minutes since anything was done for it', () => {
		expect(
			taskEndedAt({lastActiveAt, finishedAt: null}, new Date('2026-10-16T09:19:59Z')),
		).toBeNull();
	});

	test('is 20 minutes after anything was last done for it for a task never finished', () => {
		expect(taskEndedAt({lastActiveAt, finishedAt: null}, new Date('2026-10-16T09:20:00Z'))).toEqual(
			new Date('2026-10-16T09:20:00Z'),
		);
		expect(taskEndedAt({lastActiveAt, finishedAt: null}, new Date('2026-10-30T00:00:00Z'))).toEqual(
			new Date('2026-10-16T09:20:00Z'),
		);
	});
});
