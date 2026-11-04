import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {EntryRow, JobRow, ThreadRow} from '@proxy/db/harness';

import {type FakeStore, fakeStore} from './fake-store';

// The agent as it acts in the thread: signed in as the member whose conversation it is.
const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: []};

const callMcpTool = mock();
mock.module('../mcp/tools', () => ({callMcpTool}));

mock.module('./tool-surface', () => ({isGateTool: (name: string) => ['read', 'run', 'list_connections', 'list_tools', 'send_feedback'].includes(name)}));

const watchableConnections = mock();
mock.module('./watch-connections', () => ({watchableConnections}));

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
	finishedAt: null,
	createdAt: now,
};
const conversation: ThreadRow = {...thread, id: 'thread-0', parentThreadId: null, parentCallId: null, title: null, taskId: null};
// An alert as the store gives one back, set in the conversation.
const alertRow = {
	id: 'alert-1',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	threadId: 'thread-0',
	title: 'Mail from the bank',
	brief: 'The loan.',
	at: null,
	collectionId: 'emails',
	connectionIds: ['conn-a'],
	criteria: '[{"field":"from","terms":["@bank.com"]}]',
	endedAt: null,
	endedBy: null,
	createdAt: now,
};

function job(callId: string, attempts = 1): JobRow {
	return {id: 'job-1', threadId: 'thread-1', kind: 'tool', status: 'running', entryId: 'entry-1', callId, alertId: null, runAt: now, claimedBy: 'w1', attempts};
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
let startSubAgent: FakeStore['startSubAgent'];

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	({getJobThread, getEntry, completeToolJob, failJob, finishJob, startSubAgent} = store);
	for (const write of [completeToolJob, failJob, finishJob, startSubAgent]) {
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
			lastActiveAt: now,
		}),
	);
	getJobThread.mockResolvedValue(Ok(thread));
	getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'read', arguments: '{"connection":"mail-1","tool":"emails_list"}'}])));
	callMcpTool.mockResolvedValue({content: [{type: 'text', text: '{"records":[]}'}], structuredContent: {records: []}});
});

describe('runToolJob', () => {
	test('runs a gate tool through the MCP dispatch as the built-in agent, for the sub-agent’s task', async () => {
		const {runToolJob} = await import('./tool-job');

		const result = await runToolJob(store, job('c1'), 'w1', now);

		expect(result.isOk()).toBe(true);
		expect(callMcpTool).toHaveBeenCalledWith(signedIn, 'read', {connection: 'mail-1', tool: 'emails_list', task: 'task-1'}, false, 'harness');
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: '{"records":[]}', isError: false});
	});

	test('a delegation from the conversation starts the sub-agent on its title and brief, and answers nothing: the report will', async () => {
		const {runToolJob} = await import('./tool-job');
		getJobThread.mockResolvedValue(Ok(conversation));
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'delegate', arguments: '{"title":" Find the invoices ","brief":"Search the mailbox for invoices from Dana."}'}])));

		const result = await runToolJob(store, job('c1'), 'w1', now);

		expect(result.isOk()).toBe(true);
		expect(startSubAgent).toHaveBeenCalledWith('job-1', 'w1', conversation, {
			callId: 'c1',
			title: 'Find the invoices',
			task: {
				orgId: 'org-1',
				agentId: 'agent-1',
				ownerUserId: 'user-1',
				personaId: 'persona-1',
				parentId: null,
				title: 'Find the invoices',
				goal: 'Search the mailbox for invoices from Dana.',
				via: 'harness',
			},
			entries: [{kind: 'person', text: 'Search the mailbox for invoices from Dana.'}],
		});
		expect(completeToolJob).not.toHaveBeenCalled();
		expect(callMcpTool).not.toHaveBeenCalled();

		startSubAgent.mockResolvedValueOnce(Ok(false));
		expect((await runToolJob(store, job('c1'), 'w1', now)).unwrapErr().kind).toBe('conflict');
	});

	test('the conversation’s agent has no other tool, and a sub-agent can’t delegate', async () => {
		const {runToolJob} = await import('./tool-job');
		getJobThread.mockResolvedValue(Ok(conversation));
		getEntry.mockResolvedValue(
			Ok(
				entryWith([
					{id: 'c1', name: 'delegate', arguments: '{"title":"Find"}'},
					{id: 'c2', name: 'read', arguments: '{}'},
				]),
			),
		);

		await runToolJob(store, job('c1'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {callId: 'c1', text: expect.stringContaining('Give title'), isError: true});
		await runToolJob(store, job('c2'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {callId: 'c2', text: 'There is no tool read.', isError: true});
		expect(callMcpTool).not.toHaveBeenCalled();

		getJobThread.mockResolvedValue(Ok(thread));
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'delegate', arguments: '{"title":"Find","brief":"Search."}'}])));
		await runToolJob(store, job('c1'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'There is no tool delegate.', isError: true});
		expect(startSubAgent).not.toHaveBeenCalled();
	});

	test('a refused call is answered as an error, in the gate’s words', async () => {
		const {runToolJob} = await import('./tool-job');
		callMcpTool.mockResolvedValue({content: [{type: 'text', text: 'This login may not run emails_list with this connection.'}], isError: true});

		await runToolJob(store, job('c1'), 'w1', now);

		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'This login may not run emails_list with this connection.', isError: true});
	});

	test('a sleep answers with the time, since its job was due when the sleep ended', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}])));

		await runToolJob(store, job('c1'), 'w1', now);

		expect(callMcpTool).not.toHaveBeenCalled();
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'You slept, and it is now 2026-10-21T10:00:00.000Z.', isError: false});
	});

	test('a write a worker was interrupted in is not made again: the model is told the outcome is unknown', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'run', arguments: '{"connection":"mail-1","tool":"emails_send","params":{"id":"m1"}}'}])));

		await runToolJob(store, job('c1', 2), 'w1', now);

		expect(callMcpTool).not.toHaveBeenCalled();
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: expect.stringContaining('outcome of this call is unknown'), isError: true});

		// A read is simply made again.
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'read', arguments: '{}'}])));
		await runToolJob(store, job('c1', 2), 'w1', now);
		expect(callMcpTool).toHaveBeenCalledTimes(1);
	});

	test('bad arguments, an unknown tool and a missing call are answered or failed, never thrown', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(
			Ok(
				entryWith([
					{id: 'c1', name: 'read', arguments: 'not json'},
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

	test('set_alert from the conversation sets a timed alert, from the call, and answers with it; what is wrong with the arguments is answered as the error', async () => {
		const {runToolJob} = await import('./tool-job');
		getJobThread.mockResolvedValue(Ok(conversation));
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Dentist","brief":"Leave at 8.","at":"2026-10-22T07:30:00Z"}'}])));
		store.createAlert.mockResolvedValue(Ok({...alertRow, title: 'Dentist', brief: 'Leave at 8.', at: new Date('2026-10-22T07:30:00Z'), collectionId: null, connectionIds: [], criteria: null}));

		(await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now)).unwrap();

		expect(store.createAlert).toHaveBeenCalledWith(conversation, 'c1', {kind: 'time', title: 'Dentist', brief: 'Leave at 8.', at: new Date('2026-10-22T07:30:00Z')});
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-0', {
			callId: 'c1',
			text: 'Set the alert alert-1: “Dentist”, due 2026-10-22T07:30:00.000Z. The person sees it on their Alerts page.',
			isError: false,
		});

		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Dentist","brief":"Leave at 8."}'}])));
		(await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now)).unwrap();
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {callId: 'c1', text: expect.stringContaining('Give at'), isError: true});
		expect(store.createAlert).toHaveBeenCalledTimes(1);
	});

	test('set_alert with a collection sets a watch on the connections the agent may watch, those named where they are, and says which it may not', async () => {
		const {runToolJob} = await import('./tool-job');
		getJobThread.mockResolvedValue(Ok(conversation));
		watchableConnections.mockResolvedValue(
			Ok([
				{id: 'mail-1', name: 'Gmail (a@example.com)'},
				{id: 'mail-2', name: 'Work mail'},
			]),
		);
		store.createAlert.mockResolvedValue(Ok(alertRow));
		getEntry.mockResolvedValue(
			Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Mail from the bank","brief":"The loan.","collection":"emails","match":[{"field":"from","terms":["@bank.com"]}]}'}])),
		);

		(await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now)).unwrap();
		expect(watchableConnections).toHaveBeenCalledWith(signedIn, 'emails');
		expect(store.createAlert).toHaveBeenCalledWith(conversation, 'c1', {
			kind: 'watch',
			title: 'Mail from the bank',
			brief: 'The loan.',
			collectionId: 'emails',
			connectionIds: ['mail-1', 'mail-2'],
			criteria: [{field: 'from', terms: ['@bank.com']}],
		});
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-0', {
			callId: 'c1',
			text: expect.stringContaining('Set the alert alert-1: “Mail from the bank”, watching emails in connection conn-a for from contains “@bank.com”'),
			isError: false,
		});

		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Work","brief":"Work.","collection":"emails","connections":["mail-2"]}'}])));
		(await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now)).unwrap();
		expect(store.createAlert).toHaveBeenLastCalledWith(conversation, 'c1', expect.objectContaining({connectionIds: ['mail-2'], criteria: []}));

		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Work","brief":"Work.","collection":"emails","connections":["mail-9"]}'}])));
		(await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now)).unwrap();
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {
			callId: 'c1',
			text: 'You may not watch mail-9 for emails. The connections you may watch for it: mail-1 (Gmail (a@example.com)), mail-2 (Work mail).',
			isError: true,
		});

		watchableConnections.mockResolvedValue(Ok([]));
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Issues","brief":"Issues.","collection":"issues"}'}])));
		(await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now)).unwrap();
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {
			callId: 'c1',
			text: 'No connection you may read has issues: the person has to connect one, or give you access to it.',
			isError: true,
		});
		expect(store.createAlert).toHaveBeenCalledTimes(2);
	});

	test('cancel_alert from the conversation ends the alert, and says when there is none such', async () => {
		const {runToolJob} = await import('./tool-job');
		getJobThread.mockResolvedValue(Ok(conversation));
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'cancel_alert', arguments: '{"id":"alert-1"}'}])));
		store.endAlert.mockResolvedValue(Ok(true));

		(await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now)).unwrap();
		expect(store.endAlert).toHaveBeenCalledWith('thread-0', 'alert-1', 'agent', now);
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-0', {callId: 'c1', text: 'Ended the alert alert-1.', isError: false});

		store.endAlert.mockResolvedValue(Ok(false));
		(await runToolJob(store, {...job('c1'), threadId: 'thread-0'}, 'w1', now)).unwrap();
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-0', {callId: 'c1', text: 'There is no alert alert-1 still going in this conversation.', isError: true});
	});

	test('a sub-agent has no alert tools', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'set_alert', arguments: '{"title":"Dentist","brief":"Leave at 8.","at":"2026-10-22T07:30:00Z"}'}])));

		(await runToolJob(store, job('c1'), 'w1', now)).unwrap();
		expect(store.createAlert).not.toHaveBeenCalled();
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'There is no tool set_alert.', isError: true});
	});
});
