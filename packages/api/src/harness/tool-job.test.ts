import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const getJobThread = mock();
const getEntry = mock();
const completeToolJob = mock(async () => Ok(true));
const failJob = mock(async () => Ok(true));
const finishJob = mock(async () => Ok(true));
mock.module('@proxy/db/harness', () => ({getJobThread, getEntry, completeToolJob, failJob, finishJob}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', providerId: 'proxy', name: 'Personal Agent Proxy', experiments: []};
mock.module('./built-in-agent', () => ({requireBuiltInAgent: mock(async () => Ok(signedIn))}));

const ensureThreadTask = mock(async () => Ok('task-2'));
mock.module('./thread-task', () => ({ensureThreadTask}));

const callMcpTool = mock();
mock.module('../mcp/tools', () => ({callMcpTool}));

mock.module('./tool-surface', () => ({isGateTool: (name: string) => ['read', 'run', 'list_connections', 'list_tools', 'send_feedback'].includes(name)}));

const now = new Date('2026-10-21T10:00:00Z');
const thread = {id: 'thread-1', orgId: 'org-1', agentId: 'agent-1', taskId: 'task-1', createdAt: now};

function job(callId: string, attempts = 1) {
	return {id: 'job-1', threadId: 'thread-1', kind: 'tool' as const, status: 'running' as const, entryId: 'entry-1', callId, runAt: now, claimedBy: 'w1', attempts};
}

function entryWith(calls: Array<{id: string; name: string; arguments: string}>) {
	return {id: 'entry-1', seq: 2, threadId: 'thread-1', kind: 'assistant' as const, text: '', toolCalls: calls, callId: null, isError: false, inputTokens: 1, outputTokens: 1, createdAt: now};
}

beforeEach(() => {
	mock.clearAllMocks();
	getJobThread.mockResolvedValue(Ok(thread));
	getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'read', arguments: '{"connection":"mail-1","tool":"emails_list"}'}])));
	callMcpTool.mockResolvedValue({content: [{type: 'text', text: '{"records":[]}'}], structuredContent: {records: []}});
});

describe('runToolJob', () => {
	test('runs a gate tool through the MCP dispatch as the built-in agent, for the thread’s task', async () => {
		const {runToolJob} = await import('./tool-job');

		const result = await runToolJob(job('c1'), 'w1', now);

		expect(result.isOk()).toBe(true);
		expect(callMcpTool).toHaveBeenCalledWith(signedIn, 'read', {connection: 'mail-1', tool: 'emails_list', task: 'task-2'}, false, 'harness');
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: '{"records":[]}', isError: false});
	});

	test('a refused call is answered as an error, in the gate’s words', async () => {
		const {runToolJob} = await import('./tool-job');
		callMcpTool.mockResolvedValue({content: [{type: 'text', text: 'This login may not run emails_list with this connection.'}], isError: true});

		await runToolJob(job('c1'), 'w1', now);

		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'This login may not run emails_list with this connection.', isError: true});
	});

	test('a sleep answers with the time, since its job was due when the sleep ended', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}])));

		await runToolJob(job('c1'), 'w1', now);

		expect(callMcpTool).not.toHaveBeenCalled();
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'You slept, and it is now 2026-10-21T10:00:00.000Z.', isError: false});
	});

	test('a write a worker was interrupted in is not made again: the model is told the outcome is unknown', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'run', arguments: '{"connection":"mail-1","tool":"emails_send","params":{"id":"m1"}}'}])));

		await runToolJob(job('c1', 2), 'w1', now);

		expect(callMcpTool).not.toHaveBeenCalled();
		expect(completeToolJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: expect.stringContaining('outcome of this call is unknown'), isError: true});

		// A read is simply made again.
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'read', arguments: '{}'}])));
		await runToolJob(job('c1', 2), 'w1', now);
		expect(callMcpTool).toHaveBeenCalledTimes(1);
	});

	test('bad arguments, an unknown tool and a missing call are answered or failed, never thrown', async () => {
		const {runToolJob} = await import('./tool-job');
		getEntry.mockResolvedValue(Ok(entryWith([{id: 'c1', name: 'read', arguments: 'not json'}, {id: 'c2', name: 'fly', arguments: '{}'}])));

		await runToolJob(job('c1'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', {callId: 'c1', text: 'The arguments were not a JSON object.', isError: true});

		await runToolJob(job('c2'), 'w1', now);
		expect(completeToolJob).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', {callId: 'c2', text: 'There is no tool fly.', isError: true});

		await runToolJob(job('c9'), 'w1', now);
		expect(failJob).toHaveBeenCalledWith('job-1', 'w1', 'No call c9 in entry entry-1');

		getJobThread.mockResolvedValue(Ok(null));
		await runToolJob(job('c1'), 'w1', now);
		expect(finishJob).toHaveBeenCalledWith('job-1', 'w1');
	});
});
