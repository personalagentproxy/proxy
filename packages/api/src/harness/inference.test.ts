import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import type {HarnessBackend, HarnessEvent} from '@proxy/backends/harness/backend';
import {fakeHarness, fakeToolSurface} from '@proxy/backends/harness/fake';
import {ApiErr} from '@proxy/utils';
import type {JobRow, ThreadRow} from '@proxy/db/harness';

import type {ClaudeCredentials, Harnesses} from '../backends/harness';
import type {askForTurn as askForTurnOverRouter} from '../llm/open-router';
import {type FakeStore, fakeStore} from './fake-store';
import {proxyHarness} from './proxy-harness';

const agentInstructions = mock(async (_agent: unknown, flow: string) => Ok(`You are signed in.\n\n${flow}`));
mock.module('../mcp/tools', () => ({agentInstructions, callMcpTool: mock(), MCP_TOOLS: [], SCRIPT_TOOL: 'script'}));

// The model, as the proxy harness asks it, and the harness the jobs run on: the proxy harness
// over the mocked model, so that what the model is sent and what it answers are the test's.
const askForTurn = mock<typeof askForTurnOverRouter>();
const harness = proxyHarness({askForTurn, key: 'sk-test'});

const create = {name: 'create_subagent', description: 'Starts a sub-agent', parameters: {}};
const read = {name: 'read', description: 'Reads', parameters: {}};
const surface = (tool: typeof create, readOnly: boolean) => fakeToolSurface([{name: tool.name, description: tool.description, inputSchema: tool.parameters, readOnly}]);
mock.module('./tool-surface', () => ({
	toolSurfaceFor: (_store: unknown, candidate: {parentThreadId: string | null}) => (candidate.parentThreadId === null ? surface(create, false) : surface(read, true)),
}));

// How a member's Claude credential is read and what a turn tells their account, and the harnesses
// the server has: the one under test as the proxy harness, with no Claude Agent SDK harness,
// unless a test says otherwise.
const claudeCredentialFor = mock<ClaudeCredentials['claudeCredentialFor']>(async () => Ok(null));
const markRefused = mock<ClaudeCredentials['markRefused']>(async () => Ok(undefined));
const recordUsage = mock<ClaudeCredentials['recordUsage']>(async () => Ok(undefined));
const on = (proxy: HarnessBackend | null, claudeAgentSdk: HarnessBackend | null = null): Harnesses => ({
	registry: {proxy, claudeAgentSdk},
	credentials: {claudeCredentialFor, markRefused, recordUsage},
});

const now = new Date('2026-10-21T10:00:00Z');
// The time as a turn is told it, as it goes: the same throughout, unless a test moves it on.
const clock = () => now;
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
	harness: null,
	harnessSession: null,
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
		direct: false,
		inputTokens: extra.inputTokens ?? null,
		outputTokens: null,
		coversSeq: extra.coversSeq ?? null,
		system: null,
		harness: null,
		model: null,
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
let getPersonaModel: FakeStore['getPersonaModel'];
let finishJob: FakeStore['finishJob'];
let completeInference: FakeStore['completeInference'];
let requeueJob: FakeStore['requeueJob'];
let appendSummary: FakeStore['appendSummary'];
let appendTurnEntries: FakeStore['appendTurnEntries'];

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	({getJobThread, listEntries, listSubAgents, getThreadAgent, getPersonaModel, finishJob, completeInference, requeueJob, appendSummary, appendTurnEntries} = store);
	getJobThread.mockResolvedValue(Ok(thread));
	listEntries.mockResolvedValue(Ok([entry('person', 'Hi')]));
	listSubAgents.mockResolvedValue(Ok([]));
	store.listThreadAlerts.mockResolvedValue(Ok([]));
	store.listAttachments.mockResolvedValue(Ok([]));
	getThreadAgent.mockResolvedValue(Ok({agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: ['openrouter']}));
	getPersonaModel.mockResolvedValue(Ok({harness: 'proxy', chatModel: 'claude'}));
	store.getPersonaName.mockResolvedValue(Ok('Coding Agent'));
	for (const write of [finishJob, completeInference, requeueJob, appendSummary, appendTurnEntries, store.failJob]) {
		write.mockResolvedValue(Ok(true));
	}
	claudeCredentialFor.mockResolvedValue(Ok(null));
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

		const result = await runInference(store, on(harness), job, 'w1', false, clock);

		expect(result.isOk()).toBe(true);
		// The agent acts as the member whose conversation it is.
		expect(getThreadAgent).toHaveBeenCalledWith(thread);
		expect(listSubAgents).toHaveBeenCalledWith('thread-1', now);
		// What it makes goes in the persona's folder, where what the person attaches goes.
		expect(agentInstructions).toHaveBeenCalledWith(
			expect.objectContaining({agentId: 'agent-1', ownerUserId: 'user-1'}),
			expect.stringContaining('You are chatting with the person'),
			'Chats/Coding Agent',
		);
		const request = askForTurn.mock.calls[0]?.[0] as {model: string; messages: Array<Record<string, unknown>>; tools: unknown[]};
		// With the harness and the model of the persona the thread is with.
		expect(getPersonaModel).toHaveBeenCalledWith(thread);
		expect(request.model).toBe('claude');
		expect(request.messages[0]).toMatchObject({role: 'system'});
		expect(String(request.messages[0]?.content)).toContain('- thread-2: “Find the invoices”, stopped');
		expect(String(request.messages[0]?.content)).toContain('The time now is 2026-10-21T10:00:00.000Z');
		expect(request.messages.slice(1)).toEqual([
			{role: 'user', content: 'Find my invoices'},
			{
				role: 'assistant',
				content: 'Looking.',
				tool_calls: [{id: 'c1', type: 'function', function: {name: 'create_subagent', arguments: '{"title":"Find the invoices","brief":"Search the mailbox."}'}}],
			},
			{role: 'tool', tool_call_id: 'c1', content: 'Started the sub-agent “Find the invoices”, id thread-2.'},
			{role: 'user', content: expect.stringContaining('From the sub-agent “Find the invoices” (thread-2); not from the person.')},
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
				ranOn: {harness: 'proxy', model: 'claude'},
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

		await runInference(store, on(harness), job, 'w1', false, clock);

		const system = String((askForTurn.mock.calls[0]?.[0] as {messages: Array<{content: string}>}).messages[0]?.content);
		expect(system).toContain('- 3 older stopped ones, not listed');
		expect(system).toContain('- working-0: “Find the invoices”, at work');
		expect(system).not.toContain('stopped-2:');
		expect(system).toContain('- stopped-3: ');
		expect(system).toContain('- stopped-12: ');
	});

	test('tells the agent talking with the person when it has no sub-agents yet, and a sub-agent nothing of any', async () => {
		const {runInference} = await import('./inference');
		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(String((askForTurn.mock.calls[0]?.[0] as {messages: Array<{content: string}>}).messages[0]?.content)).toContain('No sub-agents yet.');

		getJobThread.mockResolvedValue(Ok(sub));
		listSubAgents.mockClear();
		await runInference(store, on(harness), {...job, threadId: 'thread-2'}, 'w1', false, clock);
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

		const result = await runInference(store, on(harness), {...job, threadId: 'thread-2'}, 'w1', false, clock);

		expect(result.isOk()).toBe(true);
		// A sub-agent's, in a folder of its title's in the persona's.
		expect(agentInstructions).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('You are a sub-agent'), 'Chats/Coding Agent/Find the invoices');

		// Where the persona is gone, no folder is named.
		store.getPersonaName.mockResolvedValue(Ok(null));
		await runInference(store, on(harness), {...job, threadId: 'thread-2'}, 'w1', false, clock);
		expect(agentInstructions).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('You are a sub-agent'), undefined);
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
					c4: {kind: 'send_to_parent', message: {text: 'Nothing yet; checking again in a minute.', isError: false}, sent: 'Sent.'},
				},
			},
		);
	});

	test('a sub-agent started without a title and a brief, or a message without text, is answered with the error at once', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'create_subagent', arguments: '{"title":"Find"}'}], inputTokens: 10, outputTokens: 2}));
		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.anything(), {plans: {c2: {kind: 'answer', text: expect.stringContaining('Give title'), isError: true}}});

		getJobThread.mockResolvedValue(Ok(sub));
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'send_to_parent', arguments: '{}'}], inputTokens: 10, outputTokens: 2}));
		await runInference(store, on(harness), {...job, threadId: 'thread-2'}, 'w1', false, clock);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.anything(), {plans: {c2: {kind: 'answer', text: expect.stringContaining('Give text'), isError: true}}});
	});

	test('a sub-agent’s tools on the conversation, and the conversation’s on a sub-agent, get a job, which answers that there is no such tool', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'send_to_parent', arguments: '{"text":"Hi"}'}], inputTokens: 10, outputTokens: 2}));
		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.anything(), {plans: {c2: {kind: 'job', runAt: now}}});

		getJobThread.mockResolvedValue(Ok(sub));
		askForTurn.mockResolvedValue(Ok({text: '', toolCalls: [{id: 'c2', name: 'create_subagent', arguments: '{"title":"Find","brief":"Go"}'}], inputTokens: 10, outputTokens: 2}));
		await runInference(store, on(harness), {...job, threadId: 'thread-2'}, 'w1', false, clock);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.anything(), {plans: {c2: {kind: 'job', runAt: now}}});
	});

	test('an answer of nothing, no words and no calls, is written as that said, so the person sees something and the log keeps no empty turn', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: ' ', toolCalls: [], inputTokens: 10, outputTokens: 0}));

		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('nothing to say'), toolCalls: [], inputTokens: 10}), {plans: {}});

		getJobThread.mockResolvedValue(Ok(sub));
		await runInference(store, on(harness), {...job, threadId: 'thread-2'}, 'w1', false, clock);
		// A sub-agent's answer without calls stops it, with that said.
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', expect.objectContaining({text: 'I stopped without saying anything.'}), {
			stop: {
				outcome: 'I stopped without saying anything.',
				stopped: {text: expect.stringContaining('I stopped without saying anything.'), isError: false},
				goingOn: {text: 'I stopped without saying anything.', isError: false},
			},
		});
	});

	test('the agent talking with the person may answer a sub-agent’s message or an alert with nothing, kept as no words', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: ' ', toolCalls: [], inputTokens: 10, outputTokens: 0}));
		listEntries.mockResolvedValue(Ok([entry('person', 'Find my invoices'), entry('event', 'Three invoices from Dana.', {callId: 'c1'})]));

		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: '', toolCalls: []}), {plans: {}});
	});

	test('a job that was no longer the worker’s by the time the answer came is a conflict', async () => {
		const {runInference} = await import('./inference');
		completeInference.mockResolvedValueOnce(Ok(false));
		expect((await runInference(store, on(harness), job, 'w1', false, clock)).unwrapErr().kind).toBe('conflict');
	});

	test('a model that refused the request, or turned the key down, fails the job with why, and is not tried again', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Err(ApiErr.unavailable('OpenRouter turned the server’s key down (401): bad key')));

		const result = await runInference(store, on(harness), job, 'w1', false, clock);

		expect(result.unwrapErr()).toMatchObject({kind: 'unavailable', message: expect.stringContaining('401')});
		expect(requeueJob).not.toHaveBeenCalled();
		expect(completeInference).not.toHaveBeenCalled();
	});

	test('a thread that is gone ends the job', async () => {
		const {runInference} = await import('./inference');
		getJobThread.mockResolvedValue(Ok(null));
		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(finishJob).toHaveBeenCalledWith('job-1', 'w1');
		expect(askForTurn).not.toHaveBeenCalled();
	});

	test('without a harness, as on a server with the SDK harness off and no key, the person is told the server is not set up', async () => {
		const {runInference} = await import('./inference');

		await runInference(store, on(null), job, 'w1', false, clock);

		expect(askForTurn).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('Chat is not set up'), toolCalls: []}), {plans: {}});
	});

	test('a model that can’t be reached is tried again later, and the person told after the last try', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));

		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(requeueJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', new Date('2026-10-21T10:00:05Z'), expect.stringContaining('The model could not be reached'));
		expect(completeInference).not.toHaveBeenCalled();

		await runInference(store, on(harness), {...job, attempts: 3}, 'w1', false, clock);
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
		listEntries.mockResolvedValue(Ok(long));
		// A persona switched to GLM: it summarizes, too.
		getPersonaModel.mockResolvedValue(Ok({harness: 'proxy', chatModel: 'glm'}));
		askForTurn
			.mockResolvedValueOnce(Ok({text: 'The person asked for one; it was done.', toolCalls: [], inputTokens: 90_000, outputTokens: 300}))
			.mockResolvedValueOnce(Ok({text: 'Three is done too.', toolCalls: [], inputTokens: 2000, outputTokens: 20}));

		const result = await runInference(store, on(harness), job, 'w1', false, clock);

		expect(result.isOk()).toBe(true);
		const asked = askForTurn.mock.calls.map((call) => call[0] as {model: string; messages: Array<{role: string; content: string | null}>; tools: unknown[]});
		expect(asked.map((request) => request.model)).toEqual(['glm', 'glm']);
		// The log to summarize goes as text, calls written out, since turns with calls need the tools sent along.
		expect(asked[0]?.tools).toEqual([]);
		expect(asked[0]?.messages[0]).toMatchObject({role: 'system', content: expect.stringContaining('Summarize this conversation')});
		expect(asked[0]?.messages.slice(1)).toEqual([{role: 'user', content: 'Person:\nOne\n\nAgent called read with {}\n\nread answered:\nrows one\n\nAgent:\nDone one\n\nWrite the summary now.'}]);
		expect(appendSummary).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {text: 'The person asked for one; it was done.', inputTokens: 90_000, outputTokens: 300}, long[3]?.seq);
		expect(listEntries).toHaveBeenCalledTimes(1);
		expect(asked[1]?.messages.slice(1).map((message) => message.content)).toEqual([expect.stringContaining('The person asked for one; it was done.'), 'Two', 'Done two', 'Three', null, 'rows three']);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'Three is done too.'}), {plans: {}});
	});

	test('after thirty answers without the person, it stops and says so; a sub-agent tells the agent it works for that it did', async () => {
		const {runInference} = await import('./inference');
		const alone = [entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))];
		listEntries.mockResolvedValue(Ok([...alone, entry('tool_result', 'x', {callId: 'none'})]));

		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(askForTurn).not.toHaveBeenCalled();
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('30 steps without hearing from you')}), {plans: {}});

		getJobThread.mockResolvedValue(Ok(sub));
		await runInference(store, on(harness), {...job, threadId: 'thread-2'}, 'w1', false, clock);
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

		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'Hello', system: expect.stringContaining('You are signed in.')}), {plans: {}});

		completeInference.mockClear();
		listEntries.mockResolvedValue(Ok([entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`)), entry('event', 'done', {callId: 'c1'})]));
		await runInference(store, on(harness), job, 'w1', false, clock);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({system: null}), {plans: {}});
	});

	test('a sub-agent’s message that comes after it stopped is acted on, not answered with the stop again', async () => {
		const {runInference} = await import('./inference');
		const alone = [entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))];
		const stopped = entry('assistant', 'I have taken 30 steps without hearing from you, so I have stopped. Tell me to go on if you want me to.');
		listEntries.mockResolvedValue(Ok([...alone, stopped, entry('event', 'Found three rows.', {callId: 'c1'})]));
		askForTurn.mockResolvedValue(Ok({text: 'There are three rows.', toolCalls: [], inputTokens: 10, outputTokens: 2}));

		await runInference(store, on(harness), job, 'w1', false, clock);

		expect(askForTurn).toHaveBeenCalledTimes(1);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'There are three rows.'}), {plans: {}});
	});

	describe('on any harness', () => {
		const done: HarnessEvent = {kind: 'done', session: null, system: 'Sent.', inputTokens: 5, outputTokens: 1};

		test('gives the harness what the person said with the files they attached to it written under it, and a sub-agent what the person wrote in its chat the same way', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			const said = entry('person', 'What does this say?');
			listEntries.mockResolvedValue(Ok([entry('person', 'Hi'), said]));
			store.listAttachments.mockResolvedValue(
				Ok([
					{
						entryId: said.id,
						connectionId: 'drive-1',
						fileId: 'file-1',
						version: 'v1',
						name: 'pricing.md',
						type: 'text/markdown',
						size: 42,
						text: '# Pricing review with Dana',
						cut: false,
						gone: false,
					},
				]),
			);
			fake.script([{kind: 'text', text: 'A pricing review.'}, done]);

			(await runInference(store, on(fake), job, 'w1', false, clock)).unwrap();

			expect(store.listAttachments).toHaveBeenCalledWith('thread-1');
			const read = fake.turns[0]?.entries.map((given) => given.text) ?? [];
			expect(read[0]).toBe('Hi');
			expect(read[1]).toStartWith('What does this say?\n\nThe person attached a file, kept in their drive.');
			expect(read[1]).toContain('pricing.md (text/markdown, 42 B): connection drive-1, id file-1, version v1. Its text:\n"""\n# Pricing review with Dana\n"""');

			// A sub-agent reads what the person attached in its chat with what they wrote there; its
			// brief, the agent's own words, has nothing attached.
			const written = entry('person', 'Use this one');
			listEntries.mockResolvedValue(Ok([entry('person', 'Read the pricing notes'), written]));
			store.listAttachments.mockResolvedValue(
				Ok([{entryId: written.id, connectionId: 'drive-1', fileId: 'file-2', version: 'v3', name: 'notes.md', type: 'text/markdown', size: 12, text: '# Notes', cut: false, gone: false}]),
			);
			getJobThread.mockResolvedValue(Ok(sub));
			fake.script([{kind: 'text', text: 'Done.'}, done]);
			(await runInference(store, on(fake), {...job, threadId: 'thread-2'}, 'w1', false, clock)).unwrap();
			expect(store.listAttachments).toHaveBeenLastCalledWith(sub.id);
			const subRead = fake.turns[1]?.entries.map((given) => given.text) ?? [];
			expect(subRead[0]).toBe('Read the pricing notes');
			expect(subRead[1]).toStartWith('Use this one\n\nThe person attached a file, kept in their drive.');
		});

		test('gives a model that sees pictures those of the person’s last two turns beside their words, and a model that doesn’t none; a picture that is lost is left out', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			const seeing = {...fake, models: [{id: 'claude', label: 'Claude', images: true as const}] satisfies HarnessBackend['models']};
			const [first, second, third] = [entry('person', 'One'), entry('person', 'Two'), entry('person', 'Three')];
			listEntries.mockResolvedValue(Ok([first, entry('assistant', 'A.'), second, entry('assistant', 'B.'), third]));
			const file = {connectionId: 'drive-1', version: 'v1', type: 'image/png', size: 42, text: null, cut: false, gone: false};
			const attached = [
				{...file, entryId: first.id, fileId: 'file-1', name: 'old.png'},
				{...file, entryId: second.id, fileId: 'file-2', name: 'chart.png'},
				{...file, entryId: third.id, fileId: 'file-3', name: 'lost.png'},
				{...file, entryId: third.id, fileId: 'file-4', name: 'notes.md', type: 'text/markdown', text: 'Notes'},
			];
			store.listAttachments.mockResolvedValue(Ok(attached));
			const picture = mock(async (attachment: {name: string; type: string}) => {
				if (attachment.name === 'lost.png') {
					return Err(ApiErr.notFound('blob', 'gone'));
				}
				return Ok(attachment.type === 'image/png' ? {name: attachment.name, mediaType: 'image/png' as const, data: 'QUJD'} : null);
			});
			fake.script([{kind: 'text', text: 'Seen.'}, done]);

			(await runInference(store, {...on(seeing), picture}, job, 'w1', false, clock)).unwrap();

			const given = fake.turns[0]?.entries.filter((one) => one.kind === 'person') ?? [];
			expect(given.map((one) => one.images)).toEqual([undefined, [{name: 'chart.png', mediaType: 'image/png', data: 'QUJD'}], undefined]);
			// The turn before last is not read again, and what the model is told of each file says which it sees.
			expect(picture.mock.calls.map(([attachment]) => attachment.name)).toEqual(['chart.png', 'lost.png', 'notes.md']);
			expect(given[0]?.text).toContain('old.png (image/png, 42 B): connection drive-1, id file-1, version v1. A picture, not shown to you here.');
			expect(given[1]?.text).toContain('chart.png (image/png, 42 B): connection drive-1, id file-2, version v1. A picture, shown to you with this message.');
			expect(given[2]?.text).toContain('lost.png (image/png, 42 B): connection drive-1, id file-3, version v1. A picture, not shown to you here.');

			// A model that sees none is given none, and nothing is read for it.
			picture.mockClear();
			fake.script([{kind: 'text', text: 'Unseen.'}, done]);
			(await runInference(store, {...on(fake), picture}, job, 'w1', false, clock)).unwrap();
			expect(picture).not.toHaveBeenCalled();
			expect(fake.turns[1]?.entries.some((one) => one.images !== undefined)).toBe(false);
		});

		test('keeps the files an answer to the person shows with it, as its steps are written and as it ends; a sub-agent’s answers show none', async () => {
			const {runInference} = await import('./inference');
			const fake: HarnessBackend & ReturnType<typeof fakeHarness> = {...fakeHarness(), stepsPerTurn: 'many'};
			const chart = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'chart.png', type: 'image/png', size: 42, text: null, cut: false};
			const pinned = mock(async (_agent: unknown, text: string) => Ok(text.includes('![') ? [chart] : []));
			const link = 'https://app.example.com/acme/connections/drive-1?file=file-1';
			fake.script([
				{kind: 'text', text: `Made it: ![Chart](${link})`},
				{kind: 'tool_call', id: 'c1', name: 'read', arguments: '{}'},
				{kind: 'tool_result', callId: 'c1', text: 'one', isError: false},
				{kind: 'text', text: `Here again: ![Chart](${link})`},
				done,
			]);

			(await runInference(store, {...on(fake), pinned}, job, 'w1', false, clock)).unwrap();

			expect(pinned.mock.calls.map(([agent, text]) => [(agent as {agentId: string}).agentId, text])).toEqual([
				['agent-1', `Made it: ![Chart](${link})`],
				['agent-1', `Here again: ![Chart](${link})`],
			]);
			expect(appendTurnEntries.mock.calls[0]?.[3]?.[0]).toMatchObject({kind: 'assistant', attachments: [chart]});
			expect(completeInference.mock.calls[0]?.[3]).toMatchObject({text: `Here again: ![Chart](${link})`, attachments: [chart]});

			// An answer showing nothing is written without files.
			fake.script([{kind: 'text', text: 'Nothing to show.'}, done]);
			(await runInference(store, {...on(fake), pinned}, job, 'w1', false, clock)).unwrap();
			expect(completeInference.mock.calls[1]?.[3]).not.toHaveProperty('attachments');

			// A sub-agent's answers are for the agent it works for.
			pinned.mockClear();
			getJobThread.mockResolvedValue(Ok(sub));
			fake.script([{kind: 'text', text: `Made it: ![Chart](${link})`}, done]);
			(await runInference(store, {...on(fake), pinned}, {...job, threadId: 'thread-2'}, 'w1', false, clock)).unwrap();
			expect(pinned).not.toHaveBeenCalled();
		});

		test('writes the answer all the same where the files it shows can’t be read, without them', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			const pinned = mock(async () => Err(ApiErr.dbError(new Error('down'))));
			fake.script([{kind: 'text', text: '![Chart](https://app.example.com/acme/connections/drive-1?file=file-1)'}, done]);

			(await runInference(store, {...on(fake), pinned}, job, 'w1', false, clock)).unwrap();

			expect(pinned).toHaveBeenCalledTimes(1);
			const written = completeInference.mock.calls[0]?.[3];
			expect(written?.text).toContain('![Chart]');
			expect(written).not.toHaveProperty('attachments');
		});

		test('tells the model nothing of the files its own answers showed', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			const answer = entry('assistant', 'Here: ![Chart](https://app.example.com/acme/connections/drive-1?file=file-1)');
			listEntries.mockResolvedValue(Ok([entry('person', 'Chart it'), answer, entry('person', 'Thanks')]));
			store.listAttachments.mockResolvedValue(
				Ok([{entryId: answer.id, connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'chart.png', type: 'image/png', size: 42, text: null, cut: false, gone: false}]),
			);
			fake.script([{kind: 'text', text: 'You’re welcome.'}, done]);

			(await runInference(store, on(fake), job, 'w1', false, clock)).unwrap();

			expect(fake.turns[0]?.entries.map((given) => given.text)).toEqual(['Chart it', answer.text, 'Thanks']);
		});

		test('gives the harness the thread, the log, its sub-agents, the prompt, the tools and the model, one step and no session, and writes the answer as it ended', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			const log = [entry('person', 'Find my invoices')];
			listEntries.mockResolvedValue(Ok(log));
			listSubAgents.mockResolvedValue(Ok([{...sub, state: {kind: 'working'}}]));
			fake.script([{kind: 'text', text: 'Looking'}, {kind: 'text', text: 'in two places.'}, {kind: 'tool_call', id: 'c2', name: 'send_to_parent', arguments: '{"text":"Hi"}'}, done]);

			const result = await runInference(store, on(fake), job, 'w1', false, clock);

			expect(result.isOk()).toBe(true);
			expect(fake.turns).toHaveLength(1);
			expect(fake.turns[0]).toMatchObject({
				thread: {id: 'thread-1', parentThreadId: null},
				job: 'job-1',
				session: null,
				entries: log,
				subAgents: [expect.objectContaining({id: 'thread-2'})],
				woken: false,
				system: expect.stringContaining('You are signed in.'),
				model: 'claude',
				maxSteps: 1,
			});
			expect(fake.turns[0]?.tools.tools.map((tool) => tool.name)).toEqual(['create_subagent']);
			expect(fake.turns[0]?.signal.aborted).toBe(false);
			// Each piece of the answer after the last, with the prompt as the harness says it sent it.
			expect(completeInference).toHaveBeenCalledWith(
				'job-1',
				'w1',
				'thread-1',
				{
					text: 'Looking\n\nin two places.',
					toolCalls: [{id: 'c2', name: 'send_to_parent', arguments: '{"text":"Hi"}'}],
					inputTokens: 5,
					outputTokens: 1,
					system: 'Sent.',
					ranOn: {harness: 'fake', model: 'claude'},
				},
				{plans: {c2: {kind: 'job', runAt: now}}},
			);
		});

		test('a turn that failed and is not worth trying again fails the job with why', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			fake.script([
				{kind: 'text', text: 'Half'},
				{kind: 'failed', error: ApiErr.internalError(new Error('refused')), retry: false},
			]);

			const result = await runInference(store, on(fake), job, 'w1', false, clock);

			expect(result.unwrapErr()).toMatchObject({kind: 'internal_error'});
			expect(requeueJob).not.toHaveBeenCalled();
			expect(completeInference).not.toHaveBeenCalled();
		});

		test('a turn that failed and is worth trying again is tried again later, whatever the error, counted from when it failed, not from when the job began', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			fake.script([{kind: 'failed', error: ApiErr.internalError(new Error('hiccup')), retry: true}]);
			// The turn took three minutes to fail: every reading of the clock after the first is then.
			const times = [now];
			const moving = () => times.shift() ?? new Date('2026-10-21T10:03:00Z');

			await runInference(store, on(fake), job, 'w1', false, moving);

			expect(requeueJob).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', new Date('2026-10-21T10:03:05Z'), expect.stringContaining('could not be reached'));
		});

		test('a member’s account at its limit is told them, with when it resets where the provider said, and not tried again; a sub-agent stops with that', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			const error = ApiErr.providerUnreachable(new Error('The model answered with rate_limit'));
			fake.script([
				{kind: 'text', text: 'Half'},
				{kind: 'failed', error, retry: false, limitReached: {resetsAt: new Date('2026-10-21T15:00:00Z')}},
			]);

			expect((await runInference(store, on(fake), job, 'w1', false, clock)).isOk()).toBe(true);

			expect(requeueJob).not.toHaveBeenCalled();
			expect(completeInference).toHaveBeenCalledWith(
				'job-1',
				'w1',
				'thread-1',
				expect.objectContaining({text: 'Your Claude account has reached its limit for now, which resets at 2026-10-21 15:00 UTC. Say something to try again after that.'}),
				{plans: {}},
			);

			getJobThread.mockResolvedValue(Ok(sub));
			fake.script([{kind: 'failed', error, retry: false, limitReached: {resetsAt: null}}]);
			expect((await runInference(store, on(fake), {...job, threadId: 'thread-2'}, 'w1', false, clock)).isOk()).toBe(true);
			expect(store.failJob).toHaveBeenCalledWith('job-1', 'w1', 'Your Claude account has reached its limit for now. Say something to try again after that.', expect.any(Function));
		});

		test('a summary the job could not store, the job no longer the worker’s, is a conflict, and the turn goes no further', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			appendSummary.mockResolvedValue(Ok(false));
			fake.script([{kind: 'summary', text: 'So far.', coversSeq: 3, inputTokens: 100, outputTokens: 10}, {kind: 'text', text: 'Then'}, done]);

			expect((await runInference(store, on(fake), job, 'w1', false, clock)).unwrapErr().kind).toBe('conflict');
			expect(appendSummary).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', {text: 'So far.', inputTokens: 100, outputTokens: 10}, 3);
			expect(completeInference).not.toHaveBeenCalled();
		});

		test('a result for a call the turn did not make, or answered already, and a turn that ends without done or failed, fail the job', async () => {
			const {runInference} = await import('./inference');
			const fake = fakeHarness();
			fake.script([{kind: 'tool_call', id: 'c1', name: 'read', arguments: '{}'}, {kind: 'tool_result', callId: 'c9', text: 'rows', isError: false}, done]);
			expect((await runInference(store, on(fake), job, 'w1', false, clock)).unwrapErr()).toMatchObject({kind: 'internal_error'});

			fake.script([
				{kind: 'tool_call', id: 'c1', name: 'read', arguments: '{}'},
				{kind: 'tool_result', callId: 'c1', text: 'rows', isError: false},
				{kind: 'tool_result', callId: 'c1', text: 'rows again', isError: false},
				done,
			]);
			expect((await runInference(store, on(fake), job, 'w1', false, clock)).unwrapErr()).toMatchObject({kind: 'internal_error'});

			fake.script([{kind: 'text', text: 'Hello'}]);
			expect((await runInference(store, on(fake), job, 'w1', false, clock)).unwrapErr()).toMatchObject({kind: 'internal_error'});
			expect(completeInference).not.toHaveBeenCalled();
		});

		test('gives a harness that runs its tools itself the thread’s session and as many steps as the thread has left', async () => {
			const {runInference} = await import('./inference');
			const fake: HarnessBackend & ReturnType<typeof fakeHarness> = {...fakeHarness('claude-agent-sdk'), stepsPerTurn: 'many'};
			const session = {id: 'session-1', state: {lastSeq: 3}};
			claudeCredentialFor.mockResolvedValue(Ok({kind: 'setup_token', token: 'sk-ant-oat01-test'}));
			getJobThread.mockResolvedValue(Ok({...thread, harness: 'claude-agent-sdk', harnessSession: session}));
			listEntries.mockResolvedValue(Ok([entry('person', 'Go'), entry('assistant', 'One'), entry('event', 'Found', {callId: 'c1'}), entry('assistant', 'Two'), entry('event', 'More', {callId: 'c1'})]));
			fake.script([{kind: 'text', text: 'Three'}, done]);

			await runInference(store, on(null, fake), job, 'w1', true, clock);

			expect(fake.turns[0]).toMatchObject({session, maxSteps: 28, woken: true, auth: {kind: 'oauth', accessToken: 'sk-ant-oat01-test', scopes: []}});
		});
	});

	describe('a harness that runs its tools itself', () => {
		const fake: HarnessBackend & ReturnType<typeof fakeHarness> = {...fakeHarness('claude-agent-sdk'), stepsPerTurn: 'many'};
		const session = {id: 'session-1', state: null};
		const ended = (kept: typeof session | null): HarnessEvent => ({kind: 'done', session: kept, system: 'Sent.', inputTokens: 50, outputTokens: 9});

		// The persona is set to the harness, with the second of its models, and the member connected
		// a Claude token, which a turn on it runs under.
		beforeEach(() => {
			getPersonaModel.mockResolvedValue(Ok({harness: 'claude-agent-sdk', chatModel: 'other'}));
			claudeCredentialFor.mockResolvedValue(Ok({kind: 'setup_token', token: 'tok'}));
		});

		test('writes each step as its first call is answered, the step’s words and calls then the result, the first step with the prompt, and the last step as the job ends, the session kept', async () => {
			const {runInference} = await import('./inference');
			getJobThread.mockResolvedValue(Ok(sub));
			fake.script([
				{kind: 'text', text: 'Looking.'},
				{kind: 'tool_call', id: 'c1', name: 'read', arguments: '{"a":1}'},
				{kind: 'tool_call', id: 'c2', name: 'read', arguments: '{"a":2}'},
				{kind: 'tool_result', callId: 'c1', text: 'one', isError: false},
				{kind: 'tool_result', callId: 'c2', text: 'two', isError: true},
				{kind: 'tool_call', id: 'c3', name: 'read', arguments: '{"a":3}'},
				{kind: 'tool_result', callId: 'c3', text: 'three', isError: false},
				{kind: 'text', text: 'Three invoices.'},
				ended(session),
			]);

			const result = await runInference(store, on(null, fake), {...job, threadId: 'thread-2'}, 'w1', false, clock);

			expect(result.isOk()).toBe(true);
			expect(appendTurnEntries.mock.calls.map((call) => call.slice(0, 3))).toEqual([
				['job-1', 'w1', 'thread-2'],
				['job-1', 'w1', 'thread-2'],
				['job-1', 'w1', 'thread-2'],
			]);
			expect(appendTurnEntries.mock.calls.map((call) => call[3])).toEqual([
				[
					{
						kind: 'assistant',
						text: 'Looking.',
						toolCalls: [
							{id: 'c1', name: 'read', arguments: '{"a":1}'},
							{id: 'c2', name: 'read', arguments: '{"a":2}'},
						],
						ranOn: {harness: 'claude-agent-sdk', model: 'other'},
						system: expect.stringContaining('You are signed in.'),
					},
					{kind: 'tool_result', callId: 'c1', text: 'one', isError: false},
				],
				[{kind: 'tool_result', callId: 'c2', text: 'two', isError: true}],
				[
					{kind: 'assistant', text: '', toolCalls: [{id: 'c3', name: 'read', arguments: '{"a":3}'}], ranOn: {harness: 'claude-agent-sdk', model: 'other'}},
					{kind: 'tool_result', callId: 'c3', text: 'three', isError: false},
				],
			]);
			// The last step is the sub-agent's answer: no calls, so it stops.
			expect(completeInference).toHaveBeenCalledWith(
				'job-1',
				'w1',
				'thread-2',
				{text: 'Three invoices.', toolCalls: [], inputTokens: 50, outputTokens: 9, system: 'Sent.', ranOn: {harness: 'claude-agent-sdk', model: 'other'}},
				{stop: expect.objectContaining({outcome: 'Three invoices.'})},
				{harness: 'claude-agent-sdk', session},
			);
		});

		test('a turn that ends with a call it answered, as a sleep ends one, writes no entry more and stops nothing; the session goes on the thread where the harness kept one, or the thread has a harness already', async () => {
			const {runInference} = await import('./inference');
			getJobThread.mockResolvedValue(Ok(sub));
			fake.script([{kind: 'tool_call', id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}, {kind: 'tool_result', callId: 'c1', text: 'Sleeping.', isError: false}, ended(null)]);
			await runInference(store, on(null, fake), {...job, threadId: 'thread-2'}, 'w1', false, clock);
			expect(appendTurnEntries).toHaveBeenCalledTimes(1);
			expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-2', null, {plans: {}});

			getJobThread.mockResolvedValue(Ok({...sub, harness: 'claude-agent-sdk'}));
			fake.script([{kind: 'tool_call', id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'}, {kind: 'tool_result', callId: 'c1', text: 'Sleeping.', isError: false}, ended(null)]);
			await runInference(store, on(null, fake), {...job, threadId: 'thread-2'}, 'w1', false, clock);
			expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-2', null, {plans: {}}, {harness: 'claude-agent-sdk', session: null});
		});

		test('a step the job could no longer write, the job no longer the worker’s, is a conflict, and the turn goes no further', async () => {
			const {runInference} = await import('./inference');
			appendTurnEntries.mockResolvedValue(Ok(false));
			fake.script([{kind: 'tool_call', id: 'c1', name: 'read', arguments: '{}'}, {kind: 'tool_result', callId: 'c1', text: 'rows', isError: false}, ended(session)]);

			expect((await runInference(store, on(null, fake), job, 'w1', false, clock)).unwrapErr().kind).toBe('conflict');
			expect(completeInference).not.toHaveBeenCalled();
		});

		test('a turn tried again that finds the last answer’s calls open closes each first, a script with its outcome unknown, and runs on the log so closed', async () => {
			const {runInference} = await import('./inference');
			getJobThread.mockResolvedValue(Ok(sub));
			const before = [
				entry('person', 'Send the invoice'),
				entry('assistant', '', {
					toolCalls: [
						{id: 'c1', name: 'script', arguments: '{}'},
						{id: 'c2', name: 'send_to_parent', arguments: '{}'},
						{id: 'c3', name: 'send_to_parent', arguments: '{}'},
					],
				}),
				entry('tool_result', 'rows', {callId: 'c2'}),
			];
			const closed = [...before, entry('tool_result', 'unknown', {callId: 'c1'}), entry('tool_result', 'interrupted', {callId: 'c3'})];
			listEntries.mockResolvedValueOnce(Ok(before)).mockResolvedValueOnce(Ok(closed));
			fake.script([{kind: 'text', text: 'Sent.'}, ended(session)]);

			await runInference(store, on(null, fake), {...job, threadId: 'thread-2', attempts: 2}, 'w1', false, clock);

			expect(appendTurnEntries).toHaveBeenCalledWith('job-1', 'w1', 'thread-2', [
				{kind: 'tool_result', callId: 'c1', text: 'Interrupted: the outcome of this call is unknown. Check what it changed before running it again.', isError: true},
				{kind: 'tool_result', callId: 'c3', text: 'This call was interrupted before it was answered.', isError: true},
			]);
			expect(fake.turns.at(-1)?.entries).toEqual(closed);
			expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-2', expect.objectContaining({text: 'Sent.'}), {stop: expect.anything()}, {harness: 'claude-agent-sdk', session});
		});

		test('a credential the model turned down is noted on the account and the person told to connect again, with no second try; a sub-agent stops with that', async () => {
			const {runInference} = await import('./inference');
			fake.script([{kind: 'failed', error: ApiErr.credentialsRejected(), retry: false}]);
			expect((await runInference(store, on(null, fake), job, 'w1', false, clock)).isOk()).toBe(true);
			expect(fake.turns.at(-1)?.auth).toEqual({kind: 'oauth', accessToken: 'tok', scopes: []});
			expect(markRefused).toHaveBeenCalledWith('user-1');
			expect(requeueJob).not.toHaveBeenCalled();
			expect(completeInference).toHaveBeenCalledWith(
				'job-1',
				'w1',
				'thread-1',
				expect.objectContaining({text: 'Your Claude sign-in has run out or was refused. Connect it again on the [Account page](/account).'}),
				{
					plans: {},
				},
			);

			// The note on the account is best effort: the person is told either way.
			markRefused.mockResolvedValueOnce(Err(ApiErr.internalError(new Error('down'))));
			claudeCredentialFor.mockResolvedValue(Ok({kind: 'api_key', key: 'sk-ant-api-test'}));
			getJobThread.mockResolvedValue(Ok(sub));
			fake.script([{kind: 'failed', error: ApiErr.credentialsRejected(), retry: false}]);
			expect((await runInference(store, on(null, fake), {...job, threadId: 'thread-2'}, 'w1', false, clock)).isOk()).toBe(true);
			expect(fake.turns.at(-1)?.auth).toEqual({kind: 'api_key', key: 'sk-ant-api-test'});
			expect(store.failJob).toHaveBeenCalledWith('job-1', 'w1', expect.stringContaining('Connect it again'), expect.any(Function));
		});

		test('what the provider said of the plan during a turn on the member’s credential is kept on their account, window by window, as of now; a failure to keep it is not the turn’s', async () => {
			const {runInference} = await import('./inference');
			const resetsAt = new Date('2026-10-21T13:00:00Z');
			recordUsage.mockResolvedValueOnce(Err(ApiErr.internalError(new Error('down'))));
			fake.script([{kind: 'usage', fiveHour: {utilization: 0.37, resetsAt}}, {kind: 'text', text: 'Hello.'}, {kind: 'usage', sevenDay: {utilization: 0.12, resetsAt: null}}, ended(session)]);

			expect((await runInference(store, on(null, fake), job, 'w1', false, clock)).isOk()).toBe(true);

			expect(recordUsage).toHaveBeenNthCalledWith(1, 'user-1', {fiveHour: {utilization: 0.37, resetsAt}, readAt: now});
			expect(recordUsage).toHaveBeenNthCalledWith(2, 'user-1', {sevenDay: {utilization: 0.12, resetsAt: null}, readAt: now});
			expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: 'Hello.'}), expect.anything(), {harness: 'claude-agent-sdk', session});
		});

		test('a turn on the server’s key keeps nothing of a usage event', async () => {
			const {runInference} = await import('./inference');
			const proxy = fakeHarness('proxy');
			getPersonaModel.mockResolvedValue(Ok({harness: 'proxy', chatModel: 'claude'}));
			proxy.script([
				{kind: 'usage', fiveHour: {utilization: 0.5, resetsAt: null}},
				{kind: 'done', session: null, system: 'Sent.', inputTokens: 1, outputTokens: 1},
			]);

			expect((await runInference(store, on(proxy, fake), job, 'w1', false, clock)).isOk()).toBe(true);

			expect(recordUsage).not.toHaveBeenCalled();
			expect(completeInference).toHaveBeenCalledTimes(1);
		});

		test('a member whose Claude sign-in ran out or was refused is told so, and one who connected none to connect it, rather than either being moved to the server’s key', async () => {
			const {runInference} = await import('./inference');
			const proxy = fakeHarness('proxy');
			claudeCredentialFor.mockResolvedValue(Err(ApiErr.unavailable('Your Claude sign-in has run out or was refused. Connect it again on the Account page.')));
			await runInference(store, on(proxy, fake), job, 'w1', false, clock);
			expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('Connect it again')}), {plans: {}});

			claudeCredentialFor.mockResolvedValue(Ok(null));
			await runInference(store, on(proxy, fake), job, 'w1', false, clock);
			expect(completeInference).toHaveBeenLastCalledWith(
				'job-1',
				'w1',
				'thread-1',
				expect.objectContaining({text: 'This agent runs on your own Claude account, and you haven’t connected one. Connect it under Claude on the [Account page](/account).'}),
				{plans: {}},
			);
			expect(proxy.turns).toHaveLength(0);

			// A sub-agent of such a persona stops with the same, for the agent it works for to hear.
			getJobThread.mockResolvedValue(Ok(sub));
			await runInference(store, on(proxy, fake), {...job, threadId: 'thread-2'}, 'w1', false, clock);
			expect(store.failJob).toHaveBeenCalledWith('job-1', 'w1', expect.stringContaining('Connect it under Claude'), expect.any(Function));
		});

		test('a persona on the proxy harness runs on the server’s key whatever the member connected, and the credential is not looked for', async () => {
			const {runInference} = await import('./inference');
			const proxy = fakeHarness('proxy');
			getPersonaModel.mockResolvedValue(Ok({harness: 'proxy', chatModel: 'other'}));
			claudeCredentialFor.mockClear();

			await runInference(store, on(proxy, fake), job, 'w1', false, clock);

			expect(claudeCredentialFor).not.toHaveBeenCalled();
			expect(proxy.turns).toHaveLength(1);
			expect(proxy.turns[0]).toMatchObject({model: 'other'});
			expect(proxy.turns[0]?.auth).toBeUndefined();
			expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({ranOn: {harness: 'proxy', model: 'other'}}), {plans: {}});
		});

		test('a persona switched to the proxy harness, or one whose harness the server turned off, runs there from its next turn, without the session the other harness left, which the thread then no longer keeps', async () => {
			const {runInference} = await import('./inference');
			const kept = {id: 'session-1', state: {lastSeq: 3, job: 'job-0'}};
			getJobThread.mockResolvedValue(Ok({...thread, harness: 'claude-agent-sdk', harnessSession: kept}));
			const proxy = fakeHarness('proxy');
			const before = fake.turns.length;

			getPersonaModel.mockResolvedValue(Ok({harness: 'proxy', chatModel: 'claude'}));
			await runInference(store, on(proxy, fake), job, 'w1', false, clock);
			// Still set to the SDK harness, on a server that hasn't got it: the first it has, and
			// that harness's first model, the one chosen being none of its.
			getPersonaModel.mockResolvedValue(Ok({harness: 'claude-agent-sdk', chatModel: 'opus'}));
			await runInference(store, on(proxy, null), job, 'w1', false, clock);

			expect(proxy.turns.map((turn) => [turn.session, turn.model])).toEqual([
				[null, 'claude'],
				[null, 'claude'],
			]);
			expect(fake.turns).toHaveLength(before);
			expect(completeInference).toHaveBeenCalledTimes(2);
			expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', expect.anything(), {plans: {}}, {harness: 'proxy', session: null});
		});

		test('a persona switched to the SDK harness runs there from its next turn, on the model chosen, without a session, on the log, each entry with the job that wrote it', async () => {
			const {runInference} = await import('./inference');
			const log = [entry('person', 'Find my invoices'), {...entry('assistant', 'Three invoices.'), jobId: 'job-0'}, entry('person', 'And last month?')];
			listEntries.mockResolvedValue(Ok(log));
			// A session another harness left is not this one's to resume.
			getJobThread.mockResolvedValue(Ok({...thread, harness: 'proxy', harnessSession: {id: 'other', state: null}}));
			fake.script([{kind: 'text', text: 'Two more.'}, ended(session)]);

			await runInference(store, on(fakeHarness('proxy'), fake), job, 'w1', false, clock);

			expect(fake.turns.at(-1)).toMatchObject({job: 'job-1', session: null, entries: log, model: 'other'});
			expect(completeInference).toHaveBeenCalledWith(
				'job-1',
				'w1',
				'thread-1',
				expect.objectContaining({text: 'Two more.', ranOn: {harness: 'claude-agent-sdk', model: 'other'}}),
				{plans: {}},
				{harness: 'claude-agent-sdk', session},
			);
		});

		test('a thread whose persona is gone runs as a new persona would, on the server’s first harness', async () => {
			const {runInference} = await import('./inference');
			const proxy = fakeHarness('proxy');
			getPersonaModel.mockResolvedValue(Ok(null));
			fake.script([ended(session)]);

			await runInference(store, on(proxy, fake), job, 'w1', false, clock);

			expect(fake.turns.at(-1)).toMatchObject({model: 'claude'});
			expect(proxy.turns).toHaveLength(0);
		});

		test('a persona on the proxy harness, in an organization without the openrouter experiment, runs on the member’s Claude account, and one who connected none is told to connect it', async () => {
			const {runInference} = await import('./inference');
			const proxy = fakeHarness('proxy');
			getThreadAgent.mockResolvedValue(Ok({agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: []}));
			getPersonaModel.mockResolvedValue(Ok({harness: 'proxy', chatModel: 'other'}));
			fake.script([ended(session)]);

			await runInference(store, on(proxy, fake), job, 'w1', false, clock);

			expect(proxy.turns).toHaveLength(0);
			expect(fake.turns.at(-1)).toMatchObject({model: 'other', auth: {kind: 'oauth', accessToken: 'tok', scopes: []}});

			claudeCredentialFor.mockResolvedValue(Ok(null));
			await runInference(store, on(proxy, fake), job, 'w1', false, clock);
			expect(proxy.turns).toHaveLength(0);
			expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-1', expect.objectContaining({text: expect.stringContaining('Connect it under Claude')}), {plans: {}});
		});

		test('a harness with a cap on its turns at once runs that many, the rest waiting their turn', async () => {
			const {runInference} = await import('./inference');
			let running = 0;
			let most = 0;
			const release: Array<() => void> = [];
			const capped: HarnessBackend = {
				...fakeHarness('capped'),
				maxConcurrentTurns: 1,
				turn: async function* () {
					running += 1;
					most = Math.max(most, running);
					await new Promise<void>((resolve) => release.push(resolve));
					running -= 1;
					yield ended(null);
				},
			};
			const turns = [runInference(store, on(capped), job, 'w1', false, clock), runInference(store, on(capped), {...job, id: 'job-2'}, 'w1', false, clock)];
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(release).toHaveLength(1);
			release[0]?.();
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(release).toHaveLength(2);
			release[1]?.();
			await Promise.all(turns);
			expect(most).toBe(1);
			expect(completeInference).toHaveBeenCalledTimes(2);
		});
	});
});

describe('a chat’s thread', () => {
	// A thread of the member's chat, which their message opened: no call started it.
	const opened: ThreadRow = {...thread, id: 'thread-3', parentThreadId: 'thread-1', title: 'Pricing review with Dana', taskId: 'task-3'};
	const threadJob: JobRow = {...job, threadId: 'thread-3'};
	const alert = {
		id: 'alert-1',
		orgId: 'org-1',
		userId: 'user-1',
		threadId: 'thread-3',
		title: 'Check the review',
		brief: 'See whether Dana moved it.',
		at: new Date('2026-10-22T07:30:00Z'),
		collectionId: null,
		connectionIds: [],
		terms: [],
		lastMatchedAt: null,
		createdAt: now,
	};
	const done: HarnessEvent = {kind: 'done', session: null, system: 'Sent.', inputTokens: 5, outputTokens: 1};

	beforeEach(() => {
		getJobThread.mockResolvedValue(Ok(opened));
		listEntries.mockResolvedValue(Ok([entry('person', 'Find the pricing review with Dana')]));
		store.listThreadAlerts.mockResolvedValue(Ok([alert]));
	});

	test('runs on its log with its own prompt and the alerts set in it, not the chat’s sub-agents, in the persona’s folder, and plans its calls: the person told at once, a sleep when it ends, a script now', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(
			Ok({
				text: '',
				toolCalls: [
					{id: 'c1', name: 'send_to_person', arguments: '{"text":"Looking through the shared drive."}'},
					{id: 'c2', name: 'sleep_until', arguments: '{"seconds":60}'},
					{id: 'c3', name: 'script', arguments: '{"code":"return 1"}'},
					{id: 'c4', name: 'create_subagent', arguments: '{"title":"a","brief":"b"}'},
				],
				inputTokens: 10,
				outputTokens: 2,
			}),
		);

		(await runInference(store, on(harness), threadJob, 'w1', false, clock)).unwrap();

		expect(listSubAgents).not.toHaveBeenCalled();
		expect(store.listThreadAlerts).toHaveBeenCalledWith('thread-3');
		expect(agentInstructions).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('You are talking with the person in a thread'), 'Chats/Coding Agent');
		const system = String((askForTurn.mock.calls[0]?.[0] as {messages: Array<{content: string}>}).messages[0]?.content);
		expect(system).toContain('- alert-1: “Check the review”, due 2026-10-22T07:30:00.000Z');
		expect(system).not.toContain('sub-agents');
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-3', expect.objectContaining({text: '', toolCalls: expect.any(Array)}), {
			plans: {
				c1: {kind: 'answer', text: 'Sent.', isError: false},
				c2: {kind: 'job', runAt: new Date('2026-10-21T10:01:00Z')},
				c3: {kind: 'job', runAt: now},
				c4: {kind: 'job', runAt: now},
			},
		});
	});

	test('ends its turn on an answer without calls, its task finished with what it said, telling nobody', async () => {
		const {runInference} = await import('./inference');
		askForTurn.mockResolvedValue(Ok({text: 'The review moved to Friday.', toolCalls: [], inputTokens: 10, outputTokens: 2}));

		(await runInference(store, on(harness), threadJob, 'w1', false, clock)).unwrap();

		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-3', expect.objectContaining({text: 'The review moved to Friday.'}), {end: {outcome: 'The review moved to Friday.'}});
	});

	test('answers the person in the thread, as the chat does, where the turn can’t run or has gone on too long without them, or said nothing, its turn ending with it', async () => {
		const {runInference} = await import('./inference');
		await runInference(store, on(null), threadJob, 'w1', false, clock);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-3', expect.objectContaining({text: expect.stringContaining('Chat is not set up'), toolCalls: []}), {
			end: {outcome: expect.stringContaining('Chat is not set up')},
		});
		expect(store.failJob).not.toHaveBeenCalled();

		listEntries.mockResolvedValue(Ok([entry('person', 'Go'), ...Array.from({length: 30}, (_, i) => entry('assistant', `step ${i}`))]));
		await runInference(store, on(harness), threadJob, 'w1', false, clock);
		expect(completeInference).toHaveBeenLastCalledWith(
			'job-1',
			'w1',
			'thread-3',
			expect.objectContaining({text: 'I have taken 30 steps without hearing from you, so I have stopped. Tell me to go on if you want me to.'}),
			{end: expect.anything()},
		);

		listEntries.mockResolvedValue(Ok([entry('person', 'Thanks')]));
		askForTurn.mockResolvedValue(Ok({text: ' ', toolCalls: [], inputTokens: 10, outputTokens: 0}));
		await runInference(store, on(harness), threadJob, 'w1', false, clock);
		expect(completeInference).toHaveBeenLastCalledWith('job-1', 'w1', 'thread-3', expect.objectContaining({text: 'I had nothing to say to that. Say something to go on.'}), {end: expect.anything()});
	});

	test('runs on a harness that runs its tools itself, each step written as it goes, and ends its turn on its last answer, showing the person the files it links', async () => {
		const {runInference} = await import('./inference');
		const fake: HarnessBackend & ReturnType<typeof fakeHarness> = {...fakeHarness('claude-agent-sdk'), stepsPerTurn: 'many'};
		getPersonaModel.mockResolvedValue(Ok({harness: 'claude-agent-sdk', chatModel: 'claude'}));
		claudeCredentialFor.mockResolvedValue(Ok({kind: 'setup_token', token: 'tok'}));
		const chart = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'chart.png', type: 'image/png', size: 42, text: null, cut: false};
		const pinned = mock(async (_agent: unknown, text: string) => Ok(text.includes('![') ? [chart] : []));
		const link = 'https://app.example.com/acme/connections/drive-1?file=file-1';
		fake.script([
			{kind: 'tool_call', id: 'c1', name: 'send_to_person', arguments: '{"text":"Looking."}'},
			{kind: 'tool_result', callId: 'c1', text: 'Sent.', isError: false},
			{kind: 'tool_call', id: 'c2', name: 'script', arguments: '{"code":"return 1"}'},
			{kind: 'tool_result', callId: 'c2', text: '1', isError: false},
			{kind: 'text', text: `It moved to Friday: ![Chart](${link})`},
			{kind: 'done', session: {id: 'session-1', state: null}, system: 'Sent.', inputTokens: 50, outputTokens: 9},
		]);

		(await runInference(store, {...on(null, fake), pinned}, threadJob, 'w1', false, clock)).unwrap();

		expect(fake.turns[0]?.thread).toEqual({id: 'thread-3', parentThreadId: 'thread-1'});
		expect(fake.turns[0]?.subAgents).toEqual([]);
		expect(appendTurnEntries.mock.calls.map((call) => call[3]?.map((written) => written.kind))).toEqual([
			['assistant', 'tool_result'],
			['assistant', 'tool_result'],
		]);
		expect(completeInference).toHaveBeenCalledWith(
			'job-1',
			'w1',
			'thread-3',
			expect.objectContaining({text: `It moved to Friday: ![Chart](${link})`, attachments: [chart], toolCalls: []}),
			{end: {outcome: `It moved to Friday: ![Chart](${link})`}},
			{harness: 'claude-agent-sdk', session: {id: 'session-1', state: null}},
		);
	});

	test('reads an alert of its that came, and may let it pass with nothing said', async () => {
		const {runInference} = await import('./inference');
		const fake = fakeHarness();
		listEntries.mockResolvedValue(Ok([entry('person', 'Tell me when Dana writes'), entry('assistant', 'I will.'), entry('event', 'The alert “Dana” matched a new one of the emails.')]));
		fake.script([done]);

		(await runInference(store, on(fake), threadJob, 'w1', false, clock)).unwrap();

		expect(fake.turns[0]?.entries.map((given) => given.kind)).toEqual(['person', 'assistant', 'event']);
		expect(completeInference).toHaveBeenCalledWith('job-1', 'w1', 'thread-3', expect.objectContaining({text: ''}), {end: {outcome: ''}});
	});
});
