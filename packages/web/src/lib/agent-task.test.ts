import {describe, expect, test} from 'bun:test';
import {isTaskRefusal, taskHome, taskRefusedPath} from '@/lib/agent-task';

describe('task paths', () => {
	test('a task’s pages start at its id, and a refused one sends back to the tasks naming it', () => {
		expect(taskHome('task-1')).toBe('/agent/task-1');
		expect(taskRefusedPath('task-1')).toBe('/agent?refused=task-1');
	});
});

describe('isTaskRefusal', () => {
	const refused = (status: number, body: unknown) => ({
		kind: 'http' as const,
		url: '/api/agent/connections/mail-1/tools/emails_list',
		status,
		body,
	});

	test('is a task that is unknown, finished or left open, and no other refusal', () => {
		expect(isTaskRefusal(refused(404, {error: 'not_found', resource: 'task'}))).toBe(true);
		expect(
			isTaskRefusal(
				refused(409, {error: 'conflict', message: 'Task task-1 (Triage inbox) is finished.'}),
			),
		).toBe(true);
		expect(isTaskRefusal(refused(404, {error: 'not_found', resource: 'connection'}))).toBe(false);
		expect(isTaskRefusal(refused(403, {error: 'forbidden'}))).toBe(false);
		expect(isTaskRefusal({kind: 'network', url: '/api', cause: null})).toBe(false);
	});
});
