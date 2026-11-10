import {beforeEach, describe, expect, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {ThreadRow} from '@proxy/db/harness';
import type {AgentTaskRow} from '@proxy/db/task';

import {type FakeStore, fakeStore} from './fake-store';
import {ensureThreadTask} from './thread-task';

const now = new Date('2026-10-21T10:00:00Z');
const MINUTE = 60 * 1000;
// A sub-agent's thread, at work on its task.
const thread: ThreadRow = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: 'thread-0',
	parentCallId: 'c0',
	title: 'Find the invoices',
	taskId: 'task-1',
	harness: null,
	harnessSession: null,
	createdAt: now,
};
const task: AgentTaskRow = {
	id: 'task-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	parentId: null,
	title: 'Find the invoices',
	goal: 'Collect the October invoices from the mail',
	via: 'harness',
	createdAt: now,
	finishedAt: null,
	outcome: null,
	lastActiveAt: now,
};

let store: FakeStore;

beforeEach(() => {
	store = fakeStore();
	store.createAgentTask.mockResolvedValue(Ok({...task, id: 'task-2'}));
	store.setThreadTask.mockResolvedValue(Ok(undefined));
});

describe('ensureThreadTask', () => {
	test('keeps the task it has while it is not finished, left open 20 minutes ago or less included', async () => {
		store.getAgentTask.mockResolvedValue(Ok({...task, lastActiveAt: new Date(Date.now() - 30 * MINUTE)}));
		const result = await ensureThreadTask(store, thread);

		expect(result.unwrap()).toBe('task-1');
		expect(store.createAgentTask).not.toHaveBeenCalled();
	});

	test('one left open more than 20 minutes ago is replaced with a new one for the same work', async () => {
		store.getAgentTask.mockResolvedValue(Ok({...task, lastActiveAt: new Date(Date.now() - 41 * MINUTE)}));
		const result = await ensureThreadTask(store, thread);

		expect(result.unwrap()).toBe('task-2');
		expect(store.createAgentTask).toHaveBeenCalledWith(expect.objectContaining({title: 'Find the invoices', parentId: null}));
		expect(store.setThreadTask).toHaveBeenCalledWith('thread-1', 'task-2');
	});

	test('one finished while the sub-agent is at work is replaced with a new one for the same work', async () => {
		store.getAgentTask.mockResolvedValue(Ok({...task, finishedAt: new Date('2026-10-21T09:00:00Z')}));
		const result = await ensureThreadTask(store, thread);

		expect(result.unwrap()).toBe('task-2');
		expect(store.createAgentTask).toHaveBeenCalledWith({
			orgId: 'org-1',
			agentId: 'agent-1',
			ownerUserId: 'user-1',
			personaId: 'persona-1',
			parentId: null,
			title: 'Find the invoices',
			goal: 'Collect the October invoices from the mail',
			via: 'harness',
		});
		expect(store.setThreadTask).toHaveBeenCalledWith('thread-1', 'task-2');
	});

	test('the agent talking with the person has no task to make calls for', async () => {
		const result = await ensureThreadTask(store, {...thread, taskId: null});

		expect(result.unwrapErr().kind).toBe('conflict');
		expect(store.getAgentTask).not.toHaveBeenCalled();
	});
});
