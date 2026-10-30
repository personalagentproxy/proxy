import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

const mockEnv: {OPENROUTER_KEY?: string} = {};
mock.module('../utils/env', () => ({env: mockEnv}));

const getJobThread = mock();
const listEntries = mock();
const finishJob = mock(async () => Ok(true));
const completeInference = mock(async () => Ok(true));
const requeueJob = mock(async () => Ok(true));
const appendSummary = mock(async () => Ok(true));
const getThreadAgent = mock(async () => Ok({agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: []}));
mock.module('@proxy/db/harness', () => ({getJobThread, listEntries, finishJob, completeInference, requeueJob, appendSummary, getThreadAgent}));

const agentInstructions = mock(async (_agent: unknown, flow: string) => Ok(`You are signed in.\n\n${flow}`));
mock.module('../mcp/tools', () => ({agentInstructions, MCP_TOOLS: []}));

const askForTurn = mock();
mock.module('../llm/open-router', () => ({askForTurn}));

const delegate = {name: 'delegate', description: 'Delegates', parameters: {}};
const read = {name: 'read', description: 'Reads', parameters: {}};
mock.module('./tool-surface', () => ({toolsFor: (candidate: {parentThreadId: string | null}) => (candidate.parentThreadId === null ? [delegate] : [read])}));

const now = new Date('2026-10-21T10:00:00Z');
// The member's conversation, and a sub-agent started from it.
const thread = {id: 'thread-1', orgId: 'org-1', agentId: 'agent-1', userId: 'user-1', parentThreadId: null, parentCallId: null, title: null, taskId: null, finishedAt: null, createdAt: now};
const sub = {...thread, id: 'thread-2', parentThreadId: 'thread-1', parentCallId: 'c0', title: 'Find the invoices', taskId: 'task-2'};
const job = {id: 'job-1', threadId: 'thread-1', kind: 'inference' as const, status: 'running' as const, entryId: null, callId: null, runAt: now, claimedBy: 'w1', attempts: 1};

let seq = 0;

function entry(
	kind: 'person' | 'assistant' | 'tool_result' | 'event' | 'summary',
	text: string,
	extra: Partial<{toolCalls: Array<{id: string; name: string; arguments: string}>; callId: string; inputTokens: number; coversSeq: number}> = {},
) {
	seq += 1;
	return {
		id: `e-${text}`,
		seq,
		threadId: 'thread-1',
		kind,
		pending: false,
		text,
		toolCalls: extra.toolCalls ?? null,
		callId: extra.callId ?? null,
		isError: false,
		inputTokens: extra.inputTokens ?? null,
		outputTokens: null,
		coversSeq: extra.coversSeq ?? null,
		system: null,
		jobId: null,
		createdAt: now,
	};
}

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.OPENROUTER_KEY = 'sk-test';
	getJobThread.mockResolvedValue(Ok(thread));
	listEntries.mockResolvedValue(Ok([entry('person', 'Hi')]));
	askForTurn.mockResolvedValue(Ok({text: 'Hello', toolCalls: [], inputTokens: 10, outputTokens: 2}));
});

describe('runInference', () => {
	test('runs the model on the conversation, as the chat form, with the one tool to delegate, and answers a delegation as started', async () => {
		const {runInference} = await import('./inference');
		const log = [
			entry('person', 'Find my invoices'),
			entry('assistant', 'Looking.', {toolCalls: [{id: 'c1', name: 'delegate', arguments: '{"title":"Find the invoices","brief":"Search the mailbox."}'}]}),
			entry('tool_result', 'Started the sub-agent “Find the invoices”.', {callId: 'c1'}),
			entry('event', 'Three invoices from Dana.', {callId: 'c1'}),
		];
		listEntries.mockResolvedValue(Ok(log));
		askForTurn.mockResolvedValue(
			Ok({
				text: 'Three invoices; I’ll have them filed.',
				toolCalls: [{id: 'c2', name: 'delegate', arguments: '{"title":"File the invoices","brief":"Save the three invoices from Dana to the vault."}'}],
				inputTokens: 10,
				outputTokens: 2,
			}),
		);

		const result = await runInference(job, 'w1', now);

		expect(result.isOk()).toBe(true);
		// The agent acts as the member whose conversation it is.
		expect(getThreadAgent).toHaveBeenCalledWith(thread);
		expect(agentInstructions).toHaveBeenCalledWith(expect.objectContaining({agentId: 'agent-1', ownerUserId: 'user-1'}), expect.stringContaining('You are talking with the person directly'));
		const request = askForTurn.mock.calls[0]?.[0] as {messages: Array<Record<string, unknown>>; tools: unknown[]};
		expect(request.messages[0]).toMatchObject({role: 'system'});
		expect(String(request.messages[0]?.content)).toContain('The time now is 2026-10-21T10:00:00.000Z');
		expect(request.messages.slice(1)).toEqual([
			{role: 'user', content: 'Find my invoices'},
			{role: 'assistant', content: 'Looking.', tool_calls: [{id: 'c1', type: 'function', function: {name: 'delegate', arguments: '{"title":"Find the invoices","brief":"Search the mailbox."}'}}]},
			{role: 'tool', tool_call_id: 'c1', content: 'Started the sub-agent “Find the invoices”.'},
			{role: 'user', content: expect.stringContaining('Three invoices from Dana.')},
		]);
		expect(request.tools).toEqual([delegate]);
		expect(completeInference).toHaveBeenCalledWith(
			'job-1',
			'w1',
			'thread-1',
			{
				text: 'Three invoices; I’ll have them filed.',
				toolCalls: [{id: 'c2', name: 'delegate', arguments: '{"title":"File the invoices","brief":"Save the three invoices from Dana to the vault."}'}],
				inputTokens: 10,
				outputTokens: 2,
				system: expect.stringContaining('You are signed in.'),
			},
			{c2: {runAt: now, placeholder: expect.stringContaining('Started the sub-agent “File the invoices”')}},
		);
	});

	test('runs a sub-agent on its log with its own tools, a sleep’s job due when it ends and a read’s now', async () => {
		const {runInference} = await import('./inference');
		getJobThread.mockResolvedValue(Ok(sub));
		listEntries.mockResolvedValue(
			Ok([entry('person', 'Search the mailbox.'), entry('assistant', '', {toolCalls: [{id: 'c1', name: 'read', arguments: '{}'}]}), entry('tool_result', '{"records":[]}', {callId: 'c1'})]),
		);
		askForTurn.mockResolvedValue(
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

		const result = await runInference({...job, threadId: 'thread-2'}, 'w1', now);

		expect(result.isOk()).toBe(true);
		expect(agentInstructions).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('You are a sub-agent'));
		const request = askForTurn.mock.calls[0]?.[0] as {messages: Array<Record<string, unknown>>; tools: unknown[]};
		expect(request.messages.slice(1)).toEqual([
			{role: 'user', content: 'Search the mailbox.'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'read', arguments: '{}'}}]},
			{role: 'tool', tool_call_id: 'c1', content: '{"records":[]}'},
		]);
		expect(request.tools).toEqual([read]);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-2', expect.objectContaining({toolCalls: [expect.objectContaining({id: 'c2'}), expect.objectContaining({id: 'c3'})]}), {
			c2: {runAt: new Date('2026-10-21T10:01:00Z'), placeholder: null},
			c3: {runAt: now, placeholder: null},
		});
	});

	test('a delegation without a title and a brief is not answered as started, so its job answers with the error', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'delegate', arguments: '{"title":"Find"}'}], inputTokens: 10, outputTokens: 2}));

		await runInference(job, 'w1', now);

		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.anything(), {c2: {runAt: now, placeholder: null}});
	});

	test('an answer of nothing, no words and no calls, is written as that said, so the person sees something and the log keeps no empty turn', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: ' ', toolCalls: [], inputTokens: 10, outputTokens: 0}));

		await runInference(job, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('nothing to say'), toolCalls: [], inputTokens: 10}), {});

		getJobThread.mockResolvedValue(Ok(sub));
		await runInference({...job, threadId: 'thread-2'}, 'w1', now);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.objectContaining({text: expect.stringContaining('without a report')}), {});
	});

	test('a job that was no longer the worker’s by the time the answer came is a conflict', async () => {
		const {runInference} = await import('./inference');
		completeInference.mockResolvedValueOnce(Ok(false));
		expect((await runInference(job, 'w1', now)).unwrapErr().kind).toBe('conflict');
	});

	test('a model that refused the request, or turned the key down, fails the job with why, and is not tried again', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Err(ApiErr.unavailable('OpenRouter turned the server’s key down (401): bad key')));

		const result = await runInference(job, 'w1', now);

		expect(result.unwrapErr()).toMatchObject({kind: 'unavailable', message: expect.stringContaining('401')});
		expect(requeueJob).not.toHaveBeenCalled();
		expect(completeInference).not.toHaveBeenCalled();
	});

	test('a sub-agent that is done, or a thread that is gone, ends the job', async () => {
		const {runInference} = await import('./inference');
		getJobThread.mockResolvedValue(Ok({...sub, finishedAt: now}));
		await runInference({...job, threadId: 'thread-2'}, 'w1', now);
		expect(finishJob).toHaveBeenCalledWith('job-1', 'w1');
		expect(askForTurn).not.toHaveBeenCalled();
	});

	test('a thread that is gone ends the job', async () => {
		const {runInference} = await import('./inference');
		getJobThread.mockResolvedValue(Ok(null));
		await runInference(job, 'w1', now);
		expect(finishJob).toHaveBeenCalledWith('job-1', 'w1');
		expect(askForTurn).not.toHaveBeenCalled();
	});

	test('without a key, the person is told the server is not set up', async () => {
		const {runInference} = await import('./inference');
		delete mockEnv.OPENROUTER_KEY;

		await runInference(job, 'w1', now);

		expect(askForTurn).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('OPENROUTER_KEY'), toolCalls: []}), {});
	});

	test('a model that can’t be reached is tried again later, and the person told after the last try', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));

		await runInference(job, 'w1', now);
		expect(requeueJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', new Date('2026-10-21T10:00:05Z'), expect.stringContaining('The model could not be reached'));
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
		askForTurn
			.mockResolvedValueOnce(Ok({text: 'The person asked for one; it was done.', toolCalls: [], inputTokens: 90_000, outputTokens: 300}))
			.mockResolvedValueOnce(Ok({text: 'Three is done too.', toolCalls: [], inputTokens: 2000, outputTokens: 20}));

		const result = await runInference(job, 'w1', now);

		expect(result.isOk()).toBe(true);
		const asked = askForTurn.mock.calls.map((call) => call[0] as {messages: Array<{role: string; content: string | null}>; tools: unknown[]});
		// The log to summarize goes as text, calls written out, since turns with calls need the tools sent along.
		expect(asked[0]?.tools).toEqual([]);
		expect(asked[0]?.messages[0]).toMatchObject({role: 'system', content: expect.stringContaining('summarizing a conversation')});
		expect(asked[0]?.messages.slice(1)).toEqual([{role: 'user', content: 'Person:\nOne\n\nAgent called read with {}\n\nread answered:\nrows one\n\nAgent:\nDone one\n\nWrite the summary now.'}]);
		expect(appendSummary).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {text: 'The person asked for one; it was done.', toolCalls: [], inputTokens: 90_000, outputTokens: 300}, long[3]?.seq);
		expect(asked[1]?.messages.slice(1).map((message) => message.content)).toEqual([expect.stringContaining('The person asked for one; it was done.'), 'Two', 'Done two', 'Three', null, 'rows three']);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'Three is done too.'}), {});
	});

	test('after thirty answers without the person, it stops and says so; a sub-agent reports that it did', async () => {
		const {runInference} = await import('./inference');
		const alone = [entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))];
		listEntries.mockResolvedValue(Ok([...alone, entry('tool_result', 'x', {callId: 'none'})]));

		await runInference(job, 'w1', now);
		expect(askForTurn).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('30 steps without hearing from you')}), {});

		getJobThread.mockResolvedValue(Ok(sub));
		await runInference({...job, threadId: 'thread-2'}, 'w1', now);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.objectContaining({text: expect.stringContaining('not a complete report')}), {});
	});

	test('the answer is written with the system prompt the model was sent; an answer given without the model, with none', async () => {
		const {runInference} = await import('./inference');
		listEntries.mockResolvedValue(Ok([entry('person', 'Hi')]));

		await runInference(job, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'Hello', system: expect.stringContaining('You are signed in.')}), {});

		completeInference.mockClear();
		listEntries.mockResolvedValue(Ok([entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`)), entry('event', 'done', {callId: 'c1'})]));
		await runInference(job, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({system: null}), {});
	});

	test('a report that comes after it stopped is acted on, not answered with the stop again', async () => {
		const {runInference} = await import('./inference');
		const alone = [entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))];
		const stopped = entry('assistant', 'I have taken 30 steps without hearing from you, so I have stopped. Tell me to go on if you want me to.');
		listEntries.mockResolvedValue(Ok([...alone, stopped, entry('event', 'Found three rows.', {callId: 'c1'})]));
		askForTurn.mockResolvedValue(Ok({text: 'There are three rows.', toolCalls: [], inputTokens: 10, outputTokens: 2}));

		await runInference(job, 'w1', now);

		expect(askForTurn).toHaveBeenCalledTimes(1);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'There are three rows.'}), {});
	});
});
