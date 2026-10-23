import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const mockEnv: {OPENROUTER_KEY?: string} = {};
mock.module('../utils/env', () => ({env: mockEnv}));

const getJobThread = mock();
const listEntries = mock();
const finishIdleInference = mock(async () => Ok(true));
const finishJob = mock(async () => Ok(true));
const completeInference = mock(async () => Ok(true));
const requeueJob = mock(async () => Ok(true));
const appendSummary = mock(async () => Ok(true));
const getThreadAgent = mock(async () => Ok({agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: []}));
mock.module('@proxy/db/harness', () => ({getJobThread, listEntries, finishIdleInference, finishJob, completeInference, requeueJob, appendSummary, getThreadAgent}));

const ensureThreadTask = mock(async () => Ok('task-1'));
mock.module('./thread-task', () => ({ensureThreadTask}));

const agentInstructions = mock(async (_agent: unknown, flow: string) => Ok(`You are signed in.\n\n${flow}`));
mock.module('../mcp/tools', () => ({agentInstructions, MCP_TOOLS: []}));

const askModel = mock();
mock.module('./model', () => ({askModel}));

mock.module('./tool-surface', () => ({MODEL_TOOLS: [{name: 'read', description: 'Reads', parameters: {}}]}));

const now = new Date('2026-10-21T10:00:00Z');
const thread = {id: 'thread-1', orgId: 'org-1', agentId: 'agent-1', userId: 'user-1', taskId: 'task-1', createdAt: now};
const job = {id: 'job-1', threadId: 'thread-1', kind: 'inference' as const, status: 'running' as const, entryId: null, callId: null, runAt: now, claimedBy: 'w1', attempts: 1};

let seq = 0;

function entry(
	kind: 'person' | 'assistant' | 'tool_result' | 'summary',
	text: string,
	extra: Partial<{toolCalls: Array<{id: string; name: string; arguments: string}>; callId: string; inputTokens: number; coversSeq: number}> = {},
) {
	seq += 1;
	return {
		id: `e-${text}`,
		seq,
		threadId: 'thread-1',
		kind,
		text,
		toolCalls: extra.toolCalls ?? null,
		callId: extra.callId ?? null,
		isError: false,
		inputTokens: extra.inputTokens ?? null,
		outputTokens: null,
		coversSeq: extra.coversSeq ?? null,
		createdAt: now,
	};
}

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.OPENROUTER_KEY = 'sk-test';
	getJobThread.mockResolvedValue(Ok(thread));
	listEntries.mockResolvedValue(Ok([entry('person', 'Hi')]));
	askModel.mockResolvedValue(Ok({text: 'Hello', toolCalls: [], inputTokens: 10, outputTokens: 2}));
});

describe('runInference', () => {
	test('runs the model on the log, as the chat form, and writes its answer with a job per call', async () => {
		const {runInference} = await import('./inference');
		listEntries.mockResolvedValue(
			Ok([entry('person', 'Hi'), entry('assistant', '', {toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]}), entry('tool_result', '{"records":[]}', {callId: 'c1'})]),
		);
		askModel.mockResolvedValue(
			Ok({
				text: '',
				toolCalls: [
					{id: 'c2', name: 'sleep_until', arguments: '{"seconds":60}'},
					{id: 'c3', name: 'read', arguments: '{}'},
				],
				inputTokens: 10,
				outputTokens: 2,
			}),
		);

		const result = await runInference(job, 'w1', now);

		expect(result.isOk()).toBe(true);
		expect(ensureThreadTask).toHaveBeenCalledWith(thread, now);
		// The agent acts as the member whose conversation it is.
		expect(getThreadAgent).toHaveBeenCalledWith(thread);
		expect(agentInstructions).toHaveBeenCalledWith(expect.objectContaining({agentId: 'agent-1', ownerUserId: 'user-1'}), expect.any(String));
		const request = askModel.mock.calls[0]?.[0] as {messages: Array<Record<string, unknown>>; tools: unknown[]};
		expect(request.messages[0]).toMatchObject({role: 'system'});
		expect(String(request.messages[0]?.content)).toContain('You are talking with the person directly');
		expect(String(request.messages[0]?.content)).toContain('The time now is 2026-10-21T10:00:00.000Z');
		expect(request.messages.slice(1)).toEqual([
			{role: 'user', content: 'Hi'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'read', arguments: '{}'}}]},
			{role: 'tool', tool_call_id: 'c1', content: '{"records":[]}'},
		]);
		expect(request.tools).toEqual([{name: 'read', description: 'Reads', parameters: {}}]);
		expect(completeInference).toHaveBeenCalledWith(
			'job-1',
			'w1',
			'thread-1',
			{
				text: '',
				toolCalls: [
					{id: 'c2', name: 'sleep_until', arguments: '{"seconds":60}'},
					{id: 'c3', name: 'read', arguments: '{}'},
				],
				inputTokens: 10,
				outputTokens: 2,
			},
			{c2: new Date('2026-10-21T10:01:00Z')},
		);
	});

	test('a log with a call still running is left alone, and a thread that is gone ends the job', async () => {
		const {runInference} = await import('./inference');
		listEntries.mockResolvedValue(Ok([entry('person', 'Hi'), entry('assistant', '', {toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]})]));
		await runInference(job, 'w1', now);
		expect(finishIdleInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1');
		expect(askModel).not.toHaveBeenCalled();

		getJobThread.mockResolvedValue(Ok(null));
		await runInference(job, 'w1', now);
		expect(finishJob).toHaveBeenCalledWith('job-1', 'w1');
	});

	test('without a key, the person is told the server is not set up', async () => {
		const {runInference} = await import('./inference');
		delete mockEnv.OPENROUTER_KEY;

		await runInference(job, 'w1', now);

		expect(askModel).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('OPENROUTER_KEY'), toolCalls: []}), {});
	});

	test('a model that can’t be reached is tried again later, and the person told after the last try', async () => {
		const {runInference} = await import('./inference');
		askModel.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));

		await runInference(job, 'w1', now);
		expect(requeueJob).toHaveBeenCalledWith('job-1', 'w1', new Date('2026-10-21T10:00:05Z'));
		expect(completeInference).not.toHaveBeenCalled();

		await runInference({...job, attempts: 3}, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('could not be reached')}), {});
	});

	test('a log grown long is summarized first, and the model reads the summary in place of what it covers', async () => {
		const {runInference} = await import('./inference');
		const {COMPACT_AT_TOKENS} = await import('./context');
		const long = [
			entry('person', 'One'),
			entry('assistant', '', {toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}], inputTokens: 10}),
			entry('tool_result', 'rows one', {callId: 'c1'}),
			entry('assistant', 'Done one', {inputTokens: 10}),
			entry('person', 'Two'),
			entry('assistant', 'Done two', {inputTokens: 10}),
			entry('person', 'Three'),
			entry('assistant', '', {toolCalls: [{id: 'c3', name: 'read', arguments: '{}'}], inputTokens: COMPACT_AT_TOKENS}),
			entry('tool_result', 'rows three', {callId: 'c3'}),
		];
		const summary = entry('summary', 'The person asked for one; it was done.', {coversSeq: long[3]?.seq});
		listEntries.mockResolvedValueOnce(Ok(long)).mockResolvedValueOnce(Ok([...long, summary]));
		askModel
			.mockResolvedValueOnce(Ok({text: 'The person asked for one; it was done.', toolCalls: [], inputTokens: 90_000, outputTokens: 300}))
			.mockResolvedValueOnce(Ok({text: 'Three is done too.', toolCalls: [], inputTokens: 2000, outputTokens: 20}));

		const result = await runInference(job, 'w1', now);

		expect(result.isOk()).toBe(true);
		const asked = askModel.mock.calls.map((call) => call[0] as {messages: Array<{role: string; content: string | null}>; tools: unknown[]});
		expect(asked[0]?.tools).toEqual([]);
		expect(asked[0]?.messages[0]).toMatchObject({role: 'system', content: expect.stringContaining('summarizing a conversation')});
		expect(asked[0]?.messages.slice(1).map((message) => message.content)).toEqual(['One', null, 'rows one', 'Done one', 'Write the summary now.']);
		expect(appendSummary).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {text: 'The person asked for one; it was done.', toolCalls: [], inputTokens: 90_000, outputTokens: 300}, long[3]?.seq);
		expect(asked[1]?.messages.slice(1).map((message) => message.content)).toEqual([expect.stringContaining('The person asked for one; it was done.'), 'Two', 'Done two', 'Three', null, 'rows three']);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'Three is done too.'}), {});
	});

	test('after thirty answers without the person, it stops and says so', async () => {
		const {runInference} = await import('./inference');
		const alone = [entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))];
		listEntries.mockResolvedValue(Ok([...alone, entry('tool_result', 'x', {callId: 'none'})]));

		await runInference(job, 'w1', now);

		expect(askModel).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('30 steps')}), {});
	});
});
