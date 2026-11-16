import {expect, test} from 'bun:test';
import {Ok} from 'ts-results-es';
import type {ThreadRow} from '@proxy/db/harness';
import {fakeStore} from './fake-store';
import {runDelegationTool} from './delegation-tools';

const thread: ThreadRow = {
	id: 'source',
	orgId: 'org',
	agentId: 'login',
	personaId: 'head',
	userId: 'member',
	parentThreadId: 'chat',
	title: 'Task',
	taskId: 'task',
	harness: null,
	harnessSession: null,
	createdAt: new Date(),
};
const job = {threadId: thread.id, jobId: 'leased-job', workerId: 'worker'};

test('invalid or oversized tasks do not reach the store', async () => {
	const store = fakeStore();
	for (const args of [
		{agentId: 'a', task: ''},
		{agentId: 'a', task: 'x'.repeat(12001)},
		{agentId: 'a', task: 'Task', privateHistory: true},
	]) {
		const result = (await runDelegationTool(store, thread, job, {id: 'c1', name: 'delegate_to_agent', arguments: JSON.stringify(args)})).unwrap();
		expect(result.isError).toBe(true);
	}
	expect(store.delegateToAgent).not.toHaveBeenCalled();
});

test('delegation forwards the lease and stable call identity, preserving a refusal', async () => {
	const store = fakeStore();
	store.delegateToAgent.mockResolvedValue(Ok({error: 'Target not authorized'}));
	const result = (await runDelegationTool(store, thread, job, {id: 'c1', name: 'delegate_to_agent', arguments: JSON.stringify({agentId: 'specialist', task: 'Compare options'})})).unwrap();
	expect(store.delegateToAgent).toHaveBeenCalledWith(job, 'leased-job:c1', 'specialist', 'Compare options');
	expect(result).toEqual({text: 'Target not authorized', isError: true});
});

test('status and cancellation are confined to the current thread', async () => {
	const store = fakeStore();
	await runDelegationTool(store, thread, job, {id: 'c1', name: 'list_delegations', arguments: '{}'});
	expect(store.listDelegations).toHaveBeenCalledWith('source');
	store.cancelDelegation.mockResolvedValue(Ok(false));
	const result = (await runDelegationTool(store, thread, job, {id: 'c2', name: 'cancel_delegation', arguments: '{"id":"another-thread-task"}'})).unwrap();
	expect(result.isError).toBe(true);
	expect(store.cancelDelegation).toHaveBeenCalledWith(job, 'another-thread-task');
});
