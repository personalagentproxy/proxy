import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const listThreads = mock();
const createThread = mock();
const getThread = mock();
const listEntries = mock();
const listOpenJobs = mock();
const appendPersonMessage = mock();
mock.module('@proxy/db/harness', () => ({listThreads, createThread, getThread, listEntries, listOpenJobs, appendPersonMessage}));

mock.module('../utils/user-org', () => ({requireUserOrgId: mock(async () => Ok('org-1'))}));

const requireBuiltInAgent = mock(async () => Ok({agentId: 'agent-1', orgId: 'org-1', providerId: 'proxy', name: 'Personal Agent Proxy', experiments: ['harness']}));
mock.module('./built-in-agent', () => ({requireBuiltInAgent}));

const createThreadTask = mock(async () => Ok('task-1'));
mock.module('./thread-task', () => ({createThreadTask}));

const now = new Date('2026-10-21T10:00:00Z');
const thread = {id: 'thread-1', orgId: 'org-1', agentId: 'agent-1', taskId: 'task-1', createdAt: now};

function request(params: Record<string, string> = {}, body: unknown = undefined, experiments: string[] = ['harness']) {
	return {user: {userId: 'user-1', email: 'a@example.com', experiments}, params, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	listThreads.mockResolvedValue(Ok([{...thread, title: 'Hi'}]));
	createThread.mockResolvedValue(Ok(thread));
	getThread.mockResolvedValue(Ok(thread));
	listEntries.mockResolvedValue(Ok([{id: 'e1', seq: 1, threadId: 'thread-1', kind: 'person', text: 'Hi', toolCalls: null, callId: null, isError: false, inputTokens: null, outputTokens: null, createdAt: now}]));
	listOpenJobs.mockResolvedValue(Ok([]));
	appendPersonMessage.mockResolvedValue(Ok({id: 'e2', seq: 2, threadId: 'thread-1', kind: 'person', text: 'Hello', toolCalls: null, callId: null, isError: false, inputTokens: null, outputTokens: null, createdAt: now}));
});

describe('the chat routes', () => {
	test('are refused without the experiment', async () => {
		const {handleListThreadsRoute, handlePostMessageRoute} = await import('./route');

		expect((await handleListThreadsRoute(request({}, undefined, []))).unwrapErr().kind).toBe('forbidden');
		expect((await handlePostMessageRoute(request({threadId: 'thread-1'}, {text: 'Hi'}, []))).unwrapErr().kind).toBe('forbidden');
		expect(appendPersonMessage).not.toHaveBeenCalled();
	});

	test('list the threads with what the person first said as the title', async () => {
		const {handleListThreadsRoute} = await import('./route');

		expect((await handleListThreadsRoute(request())).unwrap()).toEqual({threads: [{id: 'thread-1', createdAt: '2026-10-21T10:00:00.000Z', taskId: 'task-1', title: 'Hi'}]});
	});

	test('make a thread for the built-in agent, with a task for its calls', async () => {
		const {handleCreateThreadRoute} = await import('./route');

		const made = await handleCreateThreadRoute(request());

		expect(requireBuiltInAgent).toHaveBeenCalledWith('org-1');
		expect(createThreadTask).toHaveBeenCalledWith('org-1', 'agent-1');
		expect(createThread).toHaveBeenCalledWith({orgId: 'org-1', agentId: 'agent-1', taskId: 'task-1'});
		expect(made.unwrap().thread).toEqual({id: 'thread-1', createdAt: '2026-10-21T10:00:00.000Z', taskId: 'task-1', title: null});
	});

	test('give the log with whether the agent is busy or asleep', async () => {
		const {handleGetThreadRoute} = await import('./route');
		const soon = new Date(Date.now() + 60_000);
		const base = {id: 'j1', threadId: 'thread-1', kind: 'tool' as const, status: 'queued' as const, entryId: 'e1', callId: 'c1', claimedBy: null, attempts: 0};

		const idle = (await handleGetThreadRoute(request({threadId: 'thread-1'}))).unwrap();
		expect(idle.entries).toEqual([{id: 'e1', kind: 'person', text: 'Hi', toolCalls: null, callId: null, isError: false, at: '2026-10-21T10:00:00.000Z'}]);
		expect(idle).toMatchObject({busy: false, sleepingUntil: null});

		listOpenJobs.mockResolvedValue(Ok([{...base, runAt: new Date(Date.now() - 1000)}]));
		expect((await handleGetThreadRoute(request({threadId: 'thread-1'}))).unwrap()).toMatchObject({busy: true, sleepingUntil: null});

		listOpenJobs.mockResolvedValue(Ok([{...base, runAt: soon}]));
		expect((await handleGetThreadRoute(request({threadId: 'thread-1'}))).unwrap()).toMatchObject({busy: false, sleepingUntil: soon.toISOString()});

		getThread.mockResolvedValue(Ok(null));
		expect((await handleGetThreadRoute(request({threadId: 'nope'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});
	});

	test('append what the person says, trimmed, and refuse nothing or too much', async () => {
		const {handlePostMessageRoute} = await import('./route');

		const posted = await handlePostMessageRoute(request({threadId: 'thread-1'}, {text: '  Hello \n'}));
		expect(appendPersonMessage).toHaveBeenCalledWith('thread-1', 'Hello');
		expect(posted.unwrap().entry).toMatchObject({id: 'e2', kind: 'person', text: 'Hello'});

		expect((await handlePostMessageRoute(request({threadId: 'thread-1'}, {text: '   '}))).unwrapErr().kind).toBe('parse_error');
		expect((await handlePostMessageRoute(request({threadId: 'thread-1'}, {text: 'x'.repeat(20_001)}))).unwrapErr().kind).toBe('parse_error');
	});
});
