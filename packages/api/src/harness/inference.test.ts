import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import type {JobRow, ThreadRow} from '@proxy/db/harness';

import {type FakeStore, fakeStore} from './fake-store';

const mockEnv: {OPENROUTER_KEY?: string} = {};
mock.module('../utils/env', () => ({env: mockEnv}));

const agentInstructions = mock(async (_agent: unknown, flow: string) => Ok(`You are signed in.\n\n${flow}`));
mock.module('../mcp/tools', () => ({agentInstructions, MCP_TOOLS: []}));

const askForTurn = mock();
mock.module('../llm/open-router', () => ({askForTurn}));

const create = {name: 'create_subagent', description: 'Starts a sub-agent', parameters: {}};
const read = {name: 'read', description: 'Reads', parameters: {}};
mock.module('./tool-surface', () => ({toolsFor: (candidate: {parentThreadId: string | null}) => (candidate.parentThreadId === null ? [create] : [read])}));

const now = new Date('2026-10-21T10:00:00Z');
// The member's conversation, and a sub-agent started from it.
const thread: ThreadRow = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: null,
	parentCallId: null,
	title: null,
	taskId: null,
	createdAt: now,
};
const sub: ThreadRow = {...thread, id: 'thread-2', parentThreadId: 'thread-1', parentCallId: 'c0', title: 'Find the invoices', taskId: 'task-2'};
const job: JobRow = {id: 'job-1', threadId: 'thread-1', kind: 'inference', status: 'running', entryId: null, callId: null, runAt: now, claimedBy: 'w1', attempts: 1};

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

// What the store gives and takes: the thread, its log, the agent as it acts in it, and every write going through.
let store: FakeStore;
let getJobThread: FakeStore['getJobThread'];
let listEntries: FakeStore['listEntries'];
let listSubAgents: FakeStore['listSubAgents'];
let getThreadAgent: FakeStore['getThreadAgent'];
let getChatModel: FakeStore['getChatModel'];
let finishJob: FakeStore['finishJob'];
let completeInference: FakeStore['completeInference'];
let requeueJob: FakeStore['requeueJob'];
let appendSummary: FakeStore['appendSummary'];

beforeEach(() => {
	mock.clearAllMocks();
	mockEnv.OPENROUTER_KEY = 'sk-test';
	store = fakeStore();
	({getJobThread, listEntries, listSubAgents, getThreadAgent, getChatModel, finishJob, completeInference, requeueJob, appendSummary} = store);
	getJobThread.mockResolvedValue(Ok(thread));
	listEntries.mockResolvedValue(Ok([entry('person', 'Hi')]));
	listSubAgents.mockResolvedValue(Ok([]));
	store.listThreadAlerts.mockResolvedValue(Ok([]));
	getThreadAgent.mockResolvedValue(Ok({agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: []}));
	getChatModel.mockResolvedValue(Ok('claude'));
	for (const write of [finishJob, completeInference, requeueJob, appendSummary]) {
		write.mockResolvedValue(Ok(true));
	}
	askForTurn.mockResolvedValue(Ok({text: 'Hello', toolCalls: [], inputTokens: 10, outputTokens: 2}));
});

describe('runInference', () => {
	test('runs the model on the conversation, as the chat form, with its sub-agents in the prompt and whose each message is, and plans a sub-agent started and a message to one', async () => {
		const {runInference} = await import('./inference');
		const log = [
			entry('person', 'Find my invoices'),
			entry('assistant', 'Looking.', {toolCalls: [{id: 'c1', name: 'create_subagent', arguments: '{"title":"Find the invoices","brief":"Search the mailbox."}'}]}),
			entry('tool_result', 'Started the sub-agent “Find the invoices”, id thread-2.', {callId: 'c1'}),
			entry('event', 'Three invoices from Dana.', {callId: 'c1'}),
		];
		listEntries.mockResolvedValue(Ok(log));
		listSubAgents.mockResolvedValue(Ok([{...sub, parentCallId: 'c1', state: {kind: 'stopped'}}]));
		askForTurn.mockResolvedValue(
			Ok({
				text: 'Three invoices; I’ll have them filed.',
				toolCalls: [
					{id: 'c2', name: 'create_subagent', arguments: '{"title":"File the invoices","brief":"Save the three invoices from Dana to the vault."}'},
					{id: 'c3', name: 'send_to_subagent', arguments: '{"subagent":"thread-2","text":"Any from before October?"}'},
				],
				inputTokens: 10,
				outputTokens: 2,
			}),
		);

		const result = await runInference(store, job, 'w1', now);

		expect(result.isOk()).toBe(true);
		// The agent acts as the member whose conversation it is.
		expect(getThreadAgent).toHaveBeenCalledWith(thread);
		expect(listSubAgents).toHaveBeenCalledWith('thread-1', now);
		expect(agentInstructions).toHaveBeenCalledWith(expect.objectContaining({agentId: 'agent-1', ownerUserId: 'user-1'}), expect.stringContaining('You are talking with the person directly'));
		const request = askForTurn.mock.calls[0]?.[0] as {model: string; messages: Array<Record<string, unknown>>; tools: unknown[]};
		// With the model of the persona the thread is with.
		expect(getChatModel).toHaveBeenCalledWith(thread);
		expect(request.model).toBe('claude');
		expect(request.messages[0]).toMatchObject({role: 'system'});
		expect(String(request.messages[0]?.content)).toContain('- thread-2: “Find the invoices”, stopped; a message takes it up again');
		expect(String(request.messages[0]?.content)).toContain('The time now is 2026-10-21T10:00:00.000Z');
		expect(request.messages.slice(1)).toEqual([
			{role: 'user', content: 'Find my invoices'},
			{
				role: 'assistant',
				content: 'Looking.',
				tool_calls: [{id: 'c1', type: 'function', function: {name: 'create_subagent', arguments: '{"title":"Find the invoices","brief":"Search the mailbox."}'}}],
			},
			{role: 'tool', tool_call_id: 'c1', content: 'Started the sub-agent “Find the invoices”, id thread-2.'},
			{role: 'user', content: expect.stringContaining('A message from the sub-agent “Find the invoices” (id thread-2)')},
		]);
		expect(String(request.messages[4]?.content)).toContain('Three invoices from Dana.');
		expect(request.tools).toEqual([create]);
		expect(completeInference).toHaveBeenCalledWith(
			'job-1',
			'w1',
			'thread-1',
			{
				text: 'Three invoices; I’ll have them filed.',
				toolCalls: [expect.objectContaining({id: 'c2'}), expect.objectContaining({id: 'c3'})],
				inputTokens: 10,
				outputTokens: 2,
				system: expect.stringContaining('You are signed in.'),
			},
			{
				plans: {
					c2: {
						kind: 'create_subagent',
						start: expect.objectContaining({callId: 'c2', title: 'File the invoices', entries: [{kind: 'person', text: 'Save the three invoices from Dana to the vault.'}]}),
						started: expect.any(Function),
					},
					c3: {kind: 'send_to_subagent', subAgentId: 'thread-2', entry: {kind: 'person', text: 'Any from before October?'}, sent: expect.any(Function)},
				},
			},
		);
	});

	test('lists every sub-agent at work or asleep, and of those that have stopped, the latest ten, with how many older ones there are', async () => {
		const {runInference} = await import('./inference');
		const stopped = Array.from({length: 13}, (_, index) => ({...sub, id: `stopped-${index}`, state: {kind: 'stopped' as const}}));
		const working = {...sub, id: 'working-0', state: {kind: 'working' as const}};
		listSubAgents.mockResolvedValue(Ok([stopped[0], working, ...stopped.slice(1)].filter((subAgent) => subAgent !== undefined)));

		await runInference(store, job, 'w1', now);

		const system = String((askForTurn.mock.calls[0]?.[0] as {messages: Array<{content: string}>}).messages[0]?.content);
		expect(system).toContain('- 3 older sub-agents that have stopped, not listed');
		expect(system).toContain('- working-0: “Find the invoices”, at work');
		expect(system).not.toContain('stopped-2:');
		expect(system).toContain('- stopped-3: ');
		expect(system).toContain('- stopped-12: ');
	});

	test('tells the agent talking with the person when it has no sub-agents yet, and a sub-agent nothing of any', async () => {
		const {runInference} = await import('./inference');
		await runInference(store, job, 'w1', now);
		expect(String((askForTurn.mock.calls[0]?.[0] as {messages: Array<{content: string}>}).messages[0]?.content)).toContain('You have started no sub-agents yet.');

		getJobThread.mockResolvedValue(Ok(sub));
		listSubAgents.mockClear();
		await runInference(store, {...job, threadId: 'thread-2'}, 'w1', now);
		expect(listSubAgents).not.toHaveBeenCalled();
		expect(String((askForTurn.mock.calls[1]?.[0] as {messages: Array<{content: string}>}).messages[0]?.content)).not.toContain('sub-agents yet');
	});

	test('runs a sub-agent on its log with its own tools, a sleep’s job due when it ends, a read’s now, and a message to its parent sent at once', async () => {
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
					{id: 'c4', name: 'send_to_parent', arguments: '{"text":"Nothing yet; checking again in a minute."}'},
				],
				inputTokens: 10,
				outputTokens: 2,
			}),
		);

		const result = await runInference(store, {...job, threadId: 'thread-2'}, 'w1', now);

		expect(result.isOk()).toBe(true);
		expect(agentInstructions).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('You are a sub-agent'));
		const request = askForTurn.mock.calls[0]?.[0] as {messages: Array<Record<string, unknown>>; tools: unknown[]};
		expect(request.messages.slice(1)).toEqual([
			{role: 'user', content: 'Search the mailbox.'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'read', arguments: '{}'}}]},
			{role: 'tool', tool_call_id: 'c1', content: '{"records":[]}'},
		]);
		expect(request.tools).toEqual([read]);
		expect(completeInference).toHaveBeenCalledWith(
			'job-1',
			'w1',
			'thread-2',
			expect.objectContaining({toolCalls: [expect.objectContaining({id: 'c2'}), expect.objectContaining({id: 'c3'}), expect.objectContaining({id: 'c4'})]}),
			{
				plans: {
					c2: {kind: 'job', runAt: new Date('2026-10-21T10:01:00Z')},
					c3: {kind: 'job', runAt: now},
					c4: {kind: 'send_to_parent', message: {text: 'Nothing yet; checking again in a minute.', isError: false}, sent: expect.stringContaining('Sent to the agent you work for')},
				},
			},
		);
	});

	test('a sub-agent started without a title and a brief, or a message without text, is answered with the error at once', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'create_subagent', arguments: '{"title":"Find"}'}], inputTokens: 10, outputTokens: 2}));
		await runInference(store, job, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.anything(), {plans: {c2: {kind: 'answer', text: expect.stringContaining('Give title'), isError: true}}});

		getJobThread.mockResolvedValue(Ok(sub));
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'send_to_parent', arguments: '{}'}], inputTokens: 10, outputTokens: 2}));
		await runInference(store, {...job, threadId: 'thread-2'}, 'w1', now);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.anything(), {plans: {c2: {kind: 'answer', text: expect.stringContaining('Give text'), isError: true}}});
	});

	test('a sub-agent’s tools on the conversation, and the conversation’s on a sub-agent, get a job, which answers that there is no such tool', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'send_to_parent', arguments: '{"text":"Hi"}'}], inputTokens: 10, outputTokens: 2}));
		await runInference(store, job, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.anything(), {plans: {c2: {kind: 'job', runAt: now}}});

		getJobThread.mockResolvedValue(Ok(sub));
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'create_subagent', arguments: '{"title":"Find","brief":"Go"}'}], inputTokens: 10, outputTokens: 2}));
		await runInference(store, {...job, threadId: 'thread-2'}, 'w1', now);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.anything(), {plans: {c2: {kind: 'job', runAt: now}}});
	});

	test('an answer of nothing, no words and no calls, is written as that said, so the person sees something and the log keeps no empty turn', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: ' ', toolCalls: [], inputTokens: 10, outputTokens: 0}));

		await runInference(store, job, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('nothing to say'), toolCalls: [], inputTokens: 10}), {plans: {}});

		getJobThread.mockResolvedValue(Ok(sub));
		await runInference(store, {...job, threadId: 'thread-2'}, 'w1', now);
		// A sub-agent's answer without calls stops it, with that said.
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.objectContaining({text: 'I stopped without saying anything.'}), {
			stop: {
				outcome: 'I stopped without saying anything.',
				stopped: {text: expect.stringContaining('I stopped without saying anything.'), isError: false},
				goingOn: {text: 'I stopped without saying anything.', isError: false},
			},
		});
	});

	test('a job that was no longer the worker’s by the time the answer came is a conflict', async () => {
		const {runInference} = await import('./inference');
		completeInference.mockResolvedValueOnce(Ok(false));
		expect((await runInference(store, job, 'w1', now)).unwrapErr().kind).toBe('conflict');
	});

	test('a model that refused the request, or turned the key down, fails the job with why, and is not tried again', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Err(ApiErr.unavailable('OpenRouter turned the server’s key down (401): bad key')));

		const result = await runInference(store, job, 'w1', now);

		expect(result.unwrapErr()).toMatchObject({kind: 'unavailable', message: expect.stringContaining('401')});
		expect(requeueJob).not.toHaveBeenCalled();
		expect(completeInference).not.toHaveBeenCalled();
	});

	test('a thread that is gone ends the job', async () => {
		const {runInference} = await import('./inference');
		getJobThread.mockResolvedValue(Ok(null));
		await runInference(store, job, 'w1', now);
		expect(finishJob).toHaveBeenCalledWith('job-1', 'w1');
		expect(askForTurn).not.toHaveBeenCalled();
	});

	test('without a key, the person is told the server is not set up', async () => {
		const {runInference} = await import('./inference');
		delete mockEnv.OPENROUTER_KEY;

		await runInference(store, job, 'w1', now);

		expect(askForTurn).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('OPENROUTER_KEY'), toolCalls: []}), {plans: {}});
	});

	test('a model that can’t be reached is tried again later, and the person told after the last try', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));

		await runInference(store, job, 'w1', now);
		expect(requeueJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', new Date('2026-10-21T10:00:05Z'), expect.stringContaining('The model could not be reached'));
		expect(completeInference).not.toHaveBeenCalled();

		await runInference(store, {...job, attempts: 3}, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('could not be reached')}), {plans: {}});
	});

	test('a log grown long is summarized first, and the model reads the summary in place of what it covers', async () => {
		const {runInference} = await import('./inference');
		const {COMPACT_AT_TOKENS} = await import('@proxy/utils/harness-context');
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
		// A persona switched to GLM: it summarizes, too.
		getChatModel.mockResolvedValue(Ok('glm'));
		askForTurn
			.mockResolvedValueOnce(Ok({text: 'The person asked for one; it was done.', toolCalls: [], inputTokens: 90_000, outputTokens: 300}))
			.mockResolvedValueOnce(Ok({text: 'Three is done too.', toolCalls: [], inputTokens: 2000, outputTokens: 20}));

		const result = await runInference(store, job, 'w1', now);

		expect(result.isOk()).toBe(true);
		const asked = askForTurn.mock.calls.map((call) => call[0] as {model: string; messages: Array<{role: string; content: string | null}>; tools: unknown[]});
		expect(asked.map((request) => request.model)).toEqual(['glm', 'glm']);
		// The log to summarize goes as text, calls written out, since turns with calls need the tools sent along.
		expect(asked[0]?.tools).toEqual([]);
		expect(asked[0]?.messages[0]).toMatchObject({role: 'system', content: expect.stringContaining('summarizing a conversation')});
		expect(asked[0]?.messages.slice(1)).toEqual([{role: 'user', content: 'Person:\nOne\n\nAgent called read with {}\n\nread answered:\nrows one\n\nAgent:\nDone one\n\nWrite the summary now.'}]);
		expect(appendSummary).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {text: 'The person asked for one; it was done.', toolCalls: [], inputTokens: 90_000, outputTokens: 300}, long[3]?.seq);
		expect(asked[1]?.messages.slice(1).map((message) => message.content)).toEqual([expect.stringContaining('The person asked for one; it was done.'), 'Two', 'Done two', 'Three', null, 'rows three']);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'Three is done too.'}), {plans: {}});
	});

	test('after thirty answers without the person, it stops and says so; a sub-agent tells the agent it works for that it did', async () => {
		const {runInference} = await import('./inference');
		const alone = [entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))];
		listEntries.mockResolvedValue(Ok([...alone, entry('tool_result', 'x', {callId: 'none'})]));

		await runInference(store, job, 'w1', now);
		expect(askForTurn).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('30 steps without hearing from you')}), {plans: {}});

		getJobThread.mockResolvedValue(Ok(sub));
		await runInference(store, {...job, threadId: 'thread-2'}, 'w1', now);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.objectContaining({text: expect.stringContaining('not a complete answer')}), {
			stop: {
				outcome: expect.stringContaining('not a complete answer'),
				stopped: {text: expect.stringContaining('not a complete answer'), isError: false},
				goingOn: {text: expect.stringContaining('not a complete answer'), isError: false},
			},
		});
	});

	test('the answer is written with the system prompt the model was sent; an answer given without the model, with none', async () => {
		const {runInference} = await import('./inference');
		listEntries.mockResolvedValue(Ok([entry('person', 'Hi')]));

		await runInference(store, job, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'Hello', system: expect.stringContaining('You are signed in.')}), {plans: {}});

		completeInference.mockClear();
		listEntries.mockResolvedValue(Ok([entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`)), entry('event', 'done', {callId: 'c1'})]));
		await runInference(store, job, 'w1', now);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({system: null}), {plans: {}});
	});

	test('a sub-agent’s message that comes after it stopped is acted on, not answered with the stop again', async () => {
		const {runInference} = await import('./inference');
		const alone = [entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))];
		const stopped = entry('assistant', 'I have taken 30 steps without hearing from you, so I have stopped. Tell me to go on if you want me to.');
		listEntries.mockResolvedValue(Ok([...alone, stopped, entry('event', 'Found three rows.', {callId: 'c1'})]));
		askForTurn.mockResolvedValue(Ok({text: 'There are three rows.', toolCalls: [], inputTokens: 10, outputTokens: 2}));

		await runInference(store, job, 'w1', now);

		expect(askForTurn).toHaveBeenCalledTimes(1);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'There are three rows.'}), {plans: {}});
	});
});
