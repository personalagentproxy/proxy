import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const getAgentTask = mock();
const createAgentTask = mock();
mock.module('@proxy/db/task', () => ({getAgentTask, createAgentTask}));

const setThreadTask = mock(async () => Ok(undefined));
mock.module('@proxy/db/harness', () => ({setThreadTask}));

const now = new Date('2026-10-21T10:00:00Z');
// A sub-agent's thread, at work on its task.
const thread = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: 'thread-0',
	parentCallId: 'c0',
	title: 'Find the invoices',
	taskId: 'task-1',
	finishedAt: null,
	createdAt: now,
};
const task = {
	id: 'task-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	parentId: null,
	title: 'Find the invoices',
	goal: 'Collect the October invoices from the mail',
	via: 'harness' as const,
	createdAt: now,
	finishedAt: null,
	outcome: null,
	lastActiveAt: now,
};

beforeEach(() => {
	mock.clearAllMocks();
	createAgentTask.mockResolvedValue(Ok({...task, id: 'task-2'}));
});

describe('ensureThreadTask', () => {
	test('keeps the task it has while it is not finished, left open included', async () => {
		getAgentTask.mockResolvedValue(Ok({...task, lastActiveAt: new Date('2026-10-20T10:00:00Z')}));
		const {ensureThreadTask} = await import('./thread-task');
		const result = await ensureThreadTask(thread);

		expect(result.unwrap()).toBe('task-1');
		expect(createAgentTask).not.toHaveBeenCalled();
	});

	test('one finished while the sub-agent is at work is replaced with a new one for the same work', async () => {
		getAgentTask.mockResolvedValue(Ok({...task, finishedAt: new Date('2026-10-21T09:00:00Z')}));
		const {ensureThreadTask} = await import('./thread-task');
		const result = await ensureThreadTask(thread);

		expect(result.unwrap()).toBe('task-2');
		expect(createAgentTask).toHaveBeenCalledWith({
			orgId: 'org-1',
			agentId: 'agent-1',
			ownerUserId: 'user-1',
			personaId: 'persona-1',
			parentId: null,
			title: 'Find the invoices',
			goal: 'Collect the October invoices from the mail',
			via: 'harness',
		});
		expect(setThreadTask).toHaveBeenCalledWith('thread-1', 'task-2');
	});

	test('the agent talking with the person has no task to make calls for', async () => {
		const {ensureThreadTask} = await import('./thread-task');
		const result = await ensureThreadTask({...thread, taskId: null});

		expect(result.unwrapErr().kind).toBe('conflict');
		expect(getAgentTask).not.toHaveBeenCalled();
	});
});
