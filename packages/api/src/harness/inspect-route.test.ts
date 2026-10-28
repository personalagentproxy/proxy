import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';

mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL: 'http://localhost:5173'}}));

const agentInstructions = mock(async (_agent: unknown, flow: string) => Ok(`You are signed in.\n\n${flow}`));
mock.module('../mcp/tools', () => ({agentInstructions, MCP_TOOLS: []}));

const delegate = {name: 'delegate', description: 'Delegates', parameters: {}};
const read = {name: 'read', description: 'Reads', parameters: {}};
mock.module('./tool-surface', () => ({toolsFor: (candidate: {parentThreadId: string | null}) => (candidate.parentThreadId === null ? [delegate] : [read])}));

const getPersona = mock();
const getMemberThread = mock();
const listSubAgentThreads = mock();
const listThreadJobs = mock();
const listJobEvents = mock();
const listEntriesWithPending = mock();
const listEntries = mock();
const getEntry = mock();
const getJobThread = mock();
// What the route reads, and what the inference module it takes its constants from imports.
mock.module('@proxy/db/harness', () => ({
	getPersona,
	getMemberThread,
	listSubAgentThreads,
	listThreadJobs,
	listJobEvents,
	listEntriesWithPending,
	listEntries,
	getEntry,
	getJobThread,
	appendSummary: mock(),
	completeInference: mock(),
	finishJob: mock(),
	getThreadAgent: mock(),
	requeueJob: mock(),
}));

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['harness', 'debug']};
const requireViewer = mock(async () => Ok(viewer));
mock.module('../utils/user-org', () => ({requireViewer}));

const now = new Date('2026-10-21T10:00:00Z');
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
const persona = {id: 'persona-1', name: 'Finance', look, color: 'blue', createdById: 'user-1'};
const thread = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'login-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: null,
	parentCallId: null,
	title: null,
	taskId: null,
	finishedAt: null,
	createdAt: now,
};
const sub = {...thread, id: 'thread-2', parentThreadId: 'thread-1', parentCallId: 'c1', title: 'Find the invoices', taskId: 'task-2'};

type Kind = 'person' | 'assistant' | 'tool_result' | 'event' | 'summary';

function entry(
	seq: number,
	threadId: string,
	kind: Kind,
	text: string,
	extra: Partial<{toolCalls: Array<{id: string; name: string; arguments: string}>; callId: string; inputTokens: number; coversSeq: number; system: string; jobId: string; pending: boolean}> = {},
) {
	return {
		id: `e${seq}`,
		seq,
		threadId,
		kind,
		pending: extra.pending ?? false,
		text,
		toolCalls: extra.toolCalls ?? null,
		callId: extra.callId ?? null,
		isError: false,
		inputTokens: extra.inputTokens ?? null,
		outputTokens: null,
		coversSeq: extra.coversSeq ?? null,
		system: extra.system ?? null,
		jobId: extra.jobId ?? null,
		createdAt: now,
	};
}

// The person asked, the agent delegated, and the sub-agent has read once and is waiting on it.
const conversation = [
	entry(1, 'thread-1', 'person', 'Find my invoices'),
	entry(2, 'thread-1', 'assistant', '', {
		toolCalls: [{id: 'c1', name: 'delegate', arguments: '{"title":"Find the invoices","brief":"Find them"}'}],
		inputTokens: 1200,
		system: 'You are signed in.',
		jobId: 'job-1',
	}),
	entry(3, 'thread-1', 'tool_result', 'Started the sub-agent “Find the invoices”.', {callId: 'c1', jobId: 'job-2'}),
	entry(4, 'thread-1', 'assistant', 'Looking.', {inputTokens: 1300, system: 'You are signed in.', jobId: 'job-3'}),
	entry(7, 'thread-1', 'person', 'Thanks', {pending: true}),
];
const subLog = [
	entry(5, 'thread-2', 'person', 'Find them'),
	entry(6, 'thread-2', 'assistant', '', {toolCalls: [{id: 'c2', name: 'read', arguments: '{}'}], inputTokens: 800, system: 'You are a sub-agent.', jobId: 'job-4'}),
];
const jobs = [
	{
		id: 'job-1',
		threadId: 'thread-1',
		kind: 'inference' as const,
		status: 'done' as const,
		entryId: null,
		callId: null,
		runAt: now,
		claimedBy: null,
		leaseExpiresAt: null,
		attempts: 1,
		error: null,
		createdAt: now,
	},
	{
		id: 'job-5',
		threadId: 'thread-2',
		kind: 'tool' as const,
		status: 'running' as const,
		entryId: 'e6',
		callId: 'c2',
		runAt: now,
		claimedBy: 'host-1',
		leaseExpiresAt: now,
		attempts: 1,
		error: null,
		createdAt: now,
	},
];
const events = [
	{id: 'ev1', jobId: 'job-1', threadId: 'thread-1', kind: 'claimed' as const, workerId: 'host-1', error: null, at: now},
	{id: 'ev2', jobId: 'job-5', threadId: 'thread-2', kind: 'claimed' as const, workerId: 'host-1', error: null, at: now},
];

function request(params: Record<string, string> = {}) {
	return {user: {userId: 'user-1', email: 'a@example.com'}, params, body: undefined} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	requireViewer.mockResolvedValue(Ok(viewer));
	getPersona.mockResolvedValue(Ok(persona));
	getMemberThread.mockResolvedValue(Ok(thread));
	listSubAgentThreads.mockResolvedValue(Ok([sub]));
	listThreadJobs.mockResolvedValue(Ok(jobs));
	listJobEvents.mockResolvedValue(Ok(events));
	listEntriesWithPending.mockImplementation(async (threadId: string) => Ok(threadId === 'thread-1' ? conversation : subLog));
	listEntries.mockImplementation(async (threadId: string) => Ok((threadId === 'thread-1' ? conversation : subLog).filter((candidate) => !candidate.pending)));
	getEntry.mockImplementation(async (id: string) => {
		const found = [...conversation, ...subLog].find((candidate) => candidate.id === id);
		return found ? Ok(found) : Err(ApiErr.notFound('entry', id));
	});
	getJobThread.mockImplementation(async (id: string) => Ok(id === 'thread-1' ? thread : id === 'thread-2' ? sub : null));
});

describe('the inspection of a conversation', () => {
	test('is refused without the inspector experiment, as the Chat page is without its own', async () => {
		const {handleInspectThreadRoute, handleInspectRequestRoute} = await import('./inspect-route');
		requireViewer.mockResolvedValue(Ok({...viewer, experiments: ['harness']}));
		expect((await handleInspectThreadRoute(request({personaId: 'persona-1'}))).unwrapErr().kind).toBe('forbidden');
		expect((await handleInspectRequestRoute(request({entryId: 'e2'}))).unwrapErr().kind).toBe('forbidden');
	});

	test('is the conversation first, then its sub-agents, each with its whole log, its jobs and their events', async () => {
		const {handleInspectThreadRoute} = await import('./inspect-route');
		const result = (await handleInspectThreadRoute(request({personaId: 'persona-1'}))).unwrap();
		expect(result.persona.id).toBe('persona-1');
		expect(result.threads.map((candidate) => candidate.id)).toEqual(['thread-1', 'thread-2']);
		expect(listThreadJobs).toHaveBeenCalledWith(['thread-1', 'thread-2']);
		expect(listJobEvents).toHaveBeenCalledWith(['thread-1', 'thread-2']);
		const [main, agent] = result.threads;
		expect(main?.entries.map((candidate) => candidate.kind)).toEqual(['person', 'assistant', 'tool_result', 'assistant', 'person']);
		expect(main?.entries.at(-1)?.pending).toBe(true);
		expect(main?.entries[1]).toMatchObject({hasSystem: true, jobId: 'job-1', inputTokens: 1200, toolCalls: [{id: 'c1', name: 'delegate', arguments: expect.any(String)}]});
		expect(main?.jobs.map((candidate) => candidate.id)).toEqual(['job-1']);
		expect(main?.events.map((candidate) => candidate.id)).toEqual(['ev1']);
		expect(agent?.title).toBe('Find the invoices');
		expect(agent?.jobs.map((candidate) => candidate.id)).toEqual(['job-5']);
		expect(agent?.jobs[0]).toMatchObject({status: 'running', claimedBy: 'host-1', leaseExpiresAt: now.toISOString()});
	});

	test('says where each thread stands: the conversation waits for the pending turn to land, the sub-agent for its call', async () => {
		const {handleInspectThreadRoute} = await import('./inspect-route');
		const [main, agent] = (await handleInspectThreadRoute(request({personaId: 'persona-1'}))).unwrap().threads;
		// The pending turn is not in the log yet: the log ends with an answer, so the model is not due.
		expect(main?.state).toMatchObject({ready: false, pendingCalls: [], turnsAlone: 2, maxTurnsAlone: 30, lastInputTokens: 1300, compactAtTokens: 80_000, compactionCoversSeq: null});
		expect(agent?.state).toMatchObject({ready: false, pendingCalls: [{id: 'c2', name: 'read'}], turnsAlone: 1, lastInputTokens: 800});
	});

	test('is not found before the viewer has a conversation with the persona', async () => {
		const {handleInspectThreadRoute} = await import('./inspect-route');
		getMemberThread.mockResolvedValue(Ok(null));
		expect((await handleInspectThreadRoute(request({personaId: 'persona-1'}))).unwrapErr().kind).toBe('not_found');
	});
});

describe('the request behind an entry', () => {
	test('is the system prompt the answer kept, the log before it as the model read it, and the thread’s tools', async () => {
		const {handleInspectRequestRoute} = await import('./inspect-route');
		const result = (await handleInspectRequestRoute(request({entryId: 'e4'}))).unwrap();
		expect(result.kind).toBe('turn');
		expect(result.system).toBe('You are signed in.');
		expect(result.messages).toEqual([
			{role: 'system', content: 'You are signed in.'},
			{role: 'user', content: 'Find my invoices'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'delegate', arguments: '{"title":"Find the invoices","brief":"Find them"}'}}]},
			{role: 'tool', tool_call_id: 'c1', content: 'Started the sub-agent “Find the invoices”.'},
		]);
		expect(result.tools).toEqual([delegate]);
	});

	test('has a sub-agent’s tools on a sub-agent’s thread', async () => {
		const {handleInspectRequestRoute} = await import('./inspect-route');
		const result = (await handleInspectRequestRoute(request({entryId: 'e6'}))).unwrap();
		expect(result.messages).toEqual([
			{role: 'system', content: 'You are a sub-agent.'},
			{role: 'user', content: 'Find them'},
		]);
		expect(result.tools).toEqual([read]);
	});

	test('is the transcript of what a summary covers, for the model to summarize', async () => {
		const {handleInspectRequestRoute} = await import('./inspect-route');
		getEntry.mockResolvedValue(Ok(entry(5, 'thread-1', 'summary', 'The person asked for invoices.', {coversSeq: 3})));
		const result = (await handleInspectRequestRoute(request({entryId: 'e5'}))).unwrap();
		expect(result.kind).toBe('summary');
		expect(result.tools).toEqual([]);
		expect(result.messages[0]?.role).toBe('system');
		const asked = result.messages[1];
		expect(asked?.role).toBe('user');
		expect(asked?.content).toContain('Person:\nFind my invoices');
		expect(asked?.content).toContain('Agent called delegate with');
		expect(asked?.content).not.toContain('Looking.');
		expect(asked?.content).toMatch(/Write the summary now\.$/);
	});

	test('is not found for an entry of someone else’s thread, or one that is neither an answer nor a summary', async () => {
		const {handleInspectRequestRoute} = await import('./inspect-route');
		expect((await handleInspectRequestRoute(request({entryId: 'e1'}))).unwrapErr().kind).toBe('not_found');
		getJobThread.mockResolvedValue(Ok({...thread, userId: 'user-2'}));
		expect((await handleInspectRequestRoute(request({entryId: 'e2'}))).unwrapErr().kind).toBe('not_found');
	});
});
