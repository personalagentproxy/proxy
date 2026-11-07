import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {AlertRow} from '@proxy/db/alerts';
import type {EntryRow, JobRow, ThreadRow} from '@proxy/db/harness';
import {findCollection, findIntegration} from '@proxy/integrations';

import {type FakeStore, fakeStore} from './fake-store';

// The agent as it acts in the thread: signed in as the member whose conversation it is.
const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: []};

const callMcpTool = mock();
mock.module('../mcp/tools', () => ({callMcpTool}));

mock.module('./tool-surface', () => ({isGateTool: (name: string) => name === 'script'}));

// What the agent reaches, acting as the member, for a watch (alerts.ts watchableConnections), and
// the connectors, each polling its collection.
const listAgentConnections = mock();
mock.module('../agent-side/tools', () => ({listAgentConnections}));
mock.module('../records/connectors', () => ({connectorFor: () => ({list: mock(), get: mock(), changes: mock()})}));
const EMAILS_READ = findCollection(findIntegration('google') ?? {collections: []}, 'emails')?.read ?? '';

const now = new Date('2026-10-21T10:00:00Z');
// A sub-agent's thread, and the member's conversation it was started from.
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
	createdAt: now,
};
const conversation: ThreadRow = {...thread, id: 'thread-0', parentThreadId: null, parentCallId: null, title: null, taskId: null};

function job(callId: string, attempts = 1): JobRow {
	return {id: 'job-1', threadId: 'thread-1', kind: 'tool', status: 'running', entryId: 'entry-1', callId, runAt: now, claimedBy: 'w1', attempts};
}

function entryWith(calls: Array<{id: string; name: string; arguments: string}>): EntryRow {
	return {
		id: 'entry-1',
		seq: 2,
		threadId: 'thread-1',
		kind: 'assistant',
		pending: false,
		text: '',
		toolCalls: calls,
		callId: null,
		isError: false,
		inputTokens: 1,
		outputTokens: 1,
		coversSeq: null,
		system: null,
		jobId: null,
		createdAt: now,
	};
}

let store: FakeStore;
let getJobThread: FakeStore['getJobThread'];
let getEntry: FakeStore['getEntry'];
let completeToolJob: FakeStore['completeToolJob'];
let failJob: FakeStore['failJob'];
let finishJob: FakeStore['finishJob'];

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	({getJobThread, getEntry, completeToolJob, failJob, finishJob} = store);
	for (const write of [completeToolJob, failJob, finishJob]) {
		write.mockResolvedValue(Ok(true));
	}
	store.getThreadAgent.mockResolvedValue(Ok(signedIn));
	// The sub-agent's task, under way (thread-task.ts).
	store.getAgentTask.mockResolvedValue(
		Ok({
			id: 'task-1',
			agentId: 'agent-1',
			personaId: 'persona-1',
			parentId: null,
			title: 'Find the invoices',
			goal: 'Search the mailbox.',
			via: 'harness',
			createdAt: now,
			finishedAt: null,
			outcome: null,
			// Just now, whenever the test runs.
			lastActiveAt: new Date(),
		}),
	);
	getJobThread.mockResolvedValue(Ok(thread));
	getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'script', arguments: '{"code":"return await pap.call(\\"mail-1\\", \\"emails_list\\");"}'}])));
	callMcpTool.mockResolvedValue({content: [{type: 'text', text: '{"records":[]}'}]});
});

describe('runToolJob', () => {
	test('runs a gate tool through the MCP dispatch as the built-in agent, for the sub-agent’s task', async () => {
		const {runToolJob} = await import('./tool-job');

		const result = await runToolJob(store, job('c1'), 'w1', now);

		expect(result.isOk()).toBe(true);
		expect(callMcpTool).toHaveBeenCalledWith(signedIn, 'script', {code: 'return await pap.call("mail-1", "emails_list");', task: 'task-1'}, 'harness');
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: '{"records":[]}', isError: false});
	});

	test('the conversation’s agent has no tool that takes a job, and a sub-agent can’t message one', async () => {
		const {runToolJob} = await import('./tool-job');
		getJobThread.mockResolvedValue(Ok(conversation));
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'script', arguments: '{}'}])));

		await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {callId: 'c1', text: 'There is no tool script.', isError: true});
		expect(callMcpTool).not.toHaveBeenCalled();

		getJobThread.mockResolvedValue(Ok(thread));
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'send_to_subagent', arguments: '{"subagent":"thread-2","text":"Go."}'}])));
		await runToolJob(store, job('c1'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'There is no tool send_to_subagent.', isError: true});
	});

	test('a refused call is answered as an error, in the gate’s words', async () => {
		const {runToolJob} = await import('./tool-job');
		callMcpTool.mockResolvedValue({content: [{type: 'text', text: 'This login may not run emails_list with this connection.'}], isError: true});

		await runToolJob(store, job('c1'), 'w1', now);

		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'This login may not run emails_list with this connection.', isError: true});
	});

	test('a sleep answers with the time, since its job was due when the sleep ended, or a message woke it', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}])));

		await runToolJob(store, job('c1'), 'w1', now);

		expect(callMcpTool).not.toHaveBeenCalled();
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'Woken at 2026-10-21T10:00:00.000Z.', isError: false});
	});

	test('a script a worker was interrupted in is not run again, since it may have changed something: the model is told the outcome is unknown', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'script', arguments: '{"code":"await pap.call(\\"mail-1\\", \\"emails_send\\", {id: \\"m1\\"});"}'}])));

		await runToolJob(store, job('c1', 2), 'w1', now);

		expect(callMcpTool).not.toHaveBeenCalled();
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: expect.stringContaining('outcome of this call is unknown'), isError: true});
	});

	test('bad arguments, an unknown tool and a missing call are answered or failed, never thrown', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(
			Ok(
				entryWith([
					{id: 'c1', name: 'script', arguments: 'not json'},
					{id: 'c2', name: 'fly', arguments: '{}'},
				]),
			),
		);

		await runToolJob(store, job('c1'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'The arguments were not a JSON object.', isError: true});

		await runToolJob(store, job('c2'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', {callId: 'c2', text: 'There is no tool fly.', isError: true});

		await runToolJob(store, job('c9'), 'w1', now);
		expect(failJob).toHaveBeenCalledWith('job-1', 'w1', 'No call c9 in entry entry-1', expect.any(Function));

		getJobThread.mockResolvedValue(Ok(null));
		await runToolJob(store, job('c1'), 'w1', now);
		expect(finishJob).toHaveBeenCalledWith('job-1', 'w1');
	});
});

describe('the conversation’s alert calls', () => {
	const alert: AlertRow = {
		id: 'alert-1',
		orgId: 'org-1',
		userId: 'user-1',
		threadId: 'thread-0',
		title: 'Call Dana',
		brief: 'Remind them.',
		at: new Date('2026-10-22T07:30:00Z'),
		collectionId: null,
		connectionIds: [],
		terms: [],
		lastMatchedAt: null,
		createdAt: now,
	};
	const watchable = {id: 'conn-a', integrationId: 'google', account: 'a@example.com', shared: true, actions: [EMAILS_READ], tools: null, name: null};
	const set = {jobId: 'job-1', workerId: 'w1', threadId: 'thread-0', callId: 'c1'};

	// How the last set_alert call was answered, with the alert it set.
	function answered(made: AlertRow): string {
		return store.completeSetAlert.mock.calls.at(-1)?.[2](made) ?? '';
	}

	beforeEach(() => {
		getJobThread.mockResolvedValue(Ok(conversation));
		store.completeSetAlert.mockResolvedValue(Ok(true));
		store.deleteAlert.mockResolvedValue(Ok(true));
		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'proxy', name: 'Finance'}, connections: [watchable]}));
	});

	test('set_alert with a time sets a timed alert as the call is answered, saying so with its id', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Call Dana","brief":"Remind them.","at":"2026-10-22T07:30:00Z"}'}])));

		await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now);

		expect(store.completeSetAlert).toHaveBeenCalledWith(set, {kind: 'time', title: 'Call Dana', brief: 'Remind them.', at: new Date('2026-10-22T07:30:00Z')}, expect.any(Function));
		expect(answered(alert)).toBe('Set the alert alert-1: “Call Dana”, due 2026-10-22T07:30:00.000Z.');
		expect(completeToolJob).not.toHaveBeenCalled();
	});

	test('set_alert with a collection sets a watch on the connections the agent may read with it, or those named among them', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Bank","brief":"Tell me.","collection":"emails","terms":["Loan"]}'}])));
		await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now);
		expect(store.completeSetAlert).toHaveBeenLastCalledWith(
			set,
			{kind: 'watch', title: 'Bank', brief: 'Tell me.', collectionId: 'emails', connectionIds: ['conn-a'], terms: ['loan']},
			expect.any(Function),
		);

		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Bank","brief":"Tell me.","collection":"emails","connections":["conn-b"]}'}])));
		await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {
			callId: 'c1',
			text: 'You may not watch conn-b for emails. The connections you may watch for it: conn-a (Google (a@example.com)).',
			isError: true,
		});

		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'proxy', name: 'Finance'}, connections: []}));
		await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {
			callId: 'c1',
			text: 'No connection you may read has emails: the person has to connect one, or give you access to it.',
			isError: true,
		});
	});

	test('bad arguments are refused, saying what is wrong', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Bank","brief":"Tell me."}'}])));
		await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {
			callId: 'c1',
			text: 'Give at, for one message at that time, or collection, for a watch: one of the two.',
			isError: true,
		});
		expect(store.completeSetAlert).not.toHaveBeenCalled();
	});

	test('cancel_alert deletes the alert from the conversation, and says when there is none such', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'cancel_alert', arguments: '{"id":"alert-1"}'}])));
		await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now);
		expect(store.deleteAlert).toHaveBeenCalledWith('alert-1', {threadId: 'thread-0'});
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {callId: 'c1', text: 'Cancelled the alert alert-1.', isError: false});

		store.deleteAlert.mockResolvedValue(Ok(false));
		await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {
			callId: 'c1',
			text: 'No alert alert-1.',
			isError: true,
		});
	});

	test('a sub-agent has no alert tools', async () => {
		const {runToolJob} = await import('./tool-job');
		getJobThread.mockResolvedValue(Ok(thread));
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Bank","brief":"Tell me.","collection":"emails"}'}])));
		await runToolJob(store, job('c1'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'There is no tool set_alert.', isError: true});
		expect(store.completeSetAlert).not.toHaveBeenCalled();
	});
});
