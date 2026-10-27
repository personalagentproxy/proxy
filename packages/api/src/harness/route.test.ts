import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const listChatAgents = mock();
const getChatAgent = mock();
const updateChatAgent = mock();
const getMemberThread = mock();
const ensureMemberThread = mock();
const listEntries = mock();
const listOpenJobs = mock();
const listSubAgents = mock();
const appendPersonMessage = mock();
mock.module('@proxy/db/harness', () => ({listChatAgents, getChatAgent, updateChatAgent, getMemberThread, ensureMemberThread, listEntries, listOpenJobs, listSubAgents, appendPersonMessage}));

const deleteAgent = mock(async () => Ok(true));
mock.module('@proxy/db/agent', () => ({deleteAgent}));

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['harness']};
const requireViewer = mock(async () => Ok(viewer));
mock.module('../utils/user-org', () => ({requireViewer}));

const createBuiltInAgent = mock(async () => Ok({id: 'agent-2', createdById: 'user-1'}));
mock.module('./built-in-agent', () => ({createBuiltInAgent}));

const now = new Date('2026-10-21T10:00:00Z');
const agent = {id: 'agent-1', name: 'Finance', shape: 'circle', color: 'blue', createdById: 'user-1'};
const agentResponse = {id: 'agent-1', name: 'Finance', shape: 'circle', color: 'blue', mayChange: true, lastMessage: null};
const thread = {id: 'thread-1', orgId: 'org-1', agentId: 'agent-1', userId: 'user-1', parentThreadId: null, parentCallId: null, title: null, taskId: null, finishedAt: null, createdAt: now};

function request(params: Record<string, string> = {}, body: unknown = undefined) {
	return {user: {userId: 'user-1', email: 'a@example.com'}, params, body} as never;
}

beforeEach(() => {
	mock.clearAllMocks();
	requireViewer.mockResolvedValue(Ok(viewer));
	listChatAgents.mockResolvedValue(Ok([{...agent, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}}]));
	getChatAgent.mockResolvedValue(Ok(agent));
	updateChatAgent.mockResolvedValue(Ok(true));
	getMemberThread.mockResolvedValue(Ok(thread));
	ensureMemberThread.mockResolvedValue(Ok(thread));
	listEntries.mockResolvedValue(
		Ok([
			{id: 'e1', seq: 1, threadId: 'thread-1', kind: 'person', text: 'Hi', toolCalls: null, callId: null, isError: false, inputTokens: null, outputTokens: null, coversSeq: null, createdAt: now},
			{
				id: 'e2',
				seq: 2,
				threadId: 'thread-1',
				kind: 'summary',
				text: 'The person said hi.',
				toolCalls: null,
				callId: null,
				isError: false,
				inputTokens: 90_000,
				outputTokens: 10,
				coversSeq: 1,
				createdAt: now,
			},
		]),
	);
	listOpenJobs.mockResolvedValue(Ok([]));
	listSubAgents.mockResolvedValue(Ok([{id: 'thread-2', parentCallId: 'c1', title: 'Find the invoices', taskId: 'task-2', finishedAt: now}]));
	appendPersonMessage.mockResolvedValue(
		Ok({id: 'e3', seq: 3, threadId: 'thread-1', kind: 'person', text: 'Hello', toolCalls: null, callId: null, isError: false, inputTokens: null, outputTokens: null, coversSeq: null, createdAt: now}),
	);
});

describe('the chat routes', () => {
	test('are refused without the experiment', async () => {
		const {handleListChatAgentsRoute, handlePostMessageRoute} = await import('./route');
		requireViewer.mockResolvedValue(Ok({...viewer, experiments: []}));

		expect((await handleListChatAgentsRoute(request())).unwrapErr().kind).toBe('forbidden');
		expect((await handlePostMessageRoute(request({agentId: 'agent-1'}, {text: 'Hi'}))).unwrapErr().kind).toBe('forbidden');
		expect(appendPersonMessage).not.toHaveBeenCalled();
	});

	test('list the organization’s agents, with their faces, whether the viewer may change each, and the last thing said with each, on one line', async () => {
		const {handleListChatAgentsRoute} = await import('./route');
		listChatAgents.mockResolvedValue(
			Ok([
				{...agent, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}},
				{...agent, id: 'agent-3', createdById: 'user-2', lastMessage: null},
			]),
		);

		const listed = (await handleListChatAgentsRoute(request())).unwrap();

		expect(listChatAgents).toHaveBeenCalledWith('org-1', 'user-1', 'proxy');
		expect(listed).toEqual({
			agents: [
				{...agentResponse, lastMessage: {kind: 'assistant', text: 'Your vault has one entry.', at: '2026-10-21T10:00:00.000Z'}},
				{...agentResponse, id: 'agent-3', mayChange: false},
			],
		});
	});

	test('make an agent as the persona given, for everyone in the organization', async () => {
		const {handleCreateChatAgentRoute} = await import('./route');

		const made = await handleCreateChatAgentRoute(request({}, {name: ' Finance ', shape: 'circle', color: 'blue'}));

		expect(createBuiltInAgent).toHaveBeenCalledWith(viewer, {name: 'Finance', shape: 'circle', color: 'blue'});
		expect(made.unwrap().agent).toEqual({...agentResponse, id: 'agent-2'});
	});

	test('refuse a persona without a name, or with a shape or color outside the catalog', async () => {
		const {handleCreateChatAgentRoute} = await import('./route');

		expect((await handleCreateChatAgentRoute(request({}, {name: ' ', shape: 'circle', color: 'blue'}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleCreateChatAgentRoute(request({}, {name: 'Finance', shape: 'star', color: 'blue'}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleCreateChatAgentRoute(request({}, {name: 'Finance', shape: 'circle', color: 'brown'}))).unwrapErr().kind).toBe('parse_error');
		expect(createBuiltInAgent).not.toHaveBeenCalled();
	});

	test('rename an agent or change its face, and delete one with every conversation, for whoever made it or owns the organization', async () => {
		const {handleDeleteChatAgentRoute, handleUpdateChatAgentRoute} = await import('./route');
		const persona = {name: 'Money', shape: 'diamond', color: 'green'};

		const updated = await handleUpdateChatAgentRoute(request({agentId: 'agent-1'}, persona));
		expect(updateChatAgent).toHaveBeenCalledWith('org-1', 'agent-1', persona);
		expect(updated.unwrap().agent).toEqual({...agentResponse, ...persona});

		getChatAgent.mockResolvedValue(Ok({...agent, createdById: 'user-2'}));
		expect((await handleUpdateChatAgentRoute(request({agentId: 'agent-1'}, persona))).unwrapErr().kind).toBe('forbidden');
		expect((await handleDeleteChatAgentRoute(request({agentId: 'agent-1'}))).unwrapErr().kind).toBe('forbidden');
		expect(deleteAgent).not.toHaveBeenCalled();

		requireViewer.mockResolvedValue(Ok({...viewer, role: 'owner'}));
		expect((await handleDeleteChatAgentRoute(request({agentId: 'agent-1'}))).isOk()).toBe(true);
		expect(deleteAgent).toHaveBeenCalledWith('org-1', 'agent-1');

		getChatAgent.mockResolvedValue(Ok(null));
		expect((await handleDeleteChatAgentRoute(request({agentId: 'nope'}))).unwrapErr()).toMatchObject({kind: 'not_found'});
	});

	test('give the viewer’s conversation with the agent, begun where there was none, without its summaries, with its sub-agents and whether the agent is busy or asleep', async () => {
		const {handleGetThreadRoute} = await import('./route');
		const soon = new Date(Date.now() + 60_000);
		const base = {id: 'j1', threadId: 'thread-1', kind: 'tool' as const, status: 'queued' as const, entryId: 'e1', callId: 'c1', claimedBy: null, attempts: 0};

		const idle = (await handleGetThreadRoute(request({agentId: 'agent-1'}))).unwrap();
		expect(idle.agent).toEqual(agentResponse);
		expect(idle.thread).toEqual({id: 'thread-1'});
		expect(idle.entries).toEqual([{id: 'e1', kind: 'person', text: 'Hi', toolCalls: null, callId: null, isError: false, at: '2026-10-21T10:00:00.000Z'}]);
		expect(idle.subAgents).toEqual([{callId: 'c1', title: 'Find the invoices', taskId: 'task-2', finishedAt: '2026-10-21T10:00:00.000Z'}]);
		expect(idle).toMatchObject({busy: false, sleepingUntil: null});
		expect(ensureMemberThread).not.toHaveBeenCalled();

		getMemberThread.mockResolvedValue(Ok(null));
		listOpenJobs.mockResolvedValue(Ok([{...base, runAt: new Date(Date.now() - 1000)}]));
		expect((await handleGetThreadRoute(request({agentId: 'agent-1'}))).unwrap()).toMatchObject({busy: true, sleepingUntil: null});
		expect(ensureMemberThread).toHaveBeenCalledWith({orgId: 'org-1', agentId: 'agent-1', userId: 'user-1'});

		listOpenJobs.mockResolvedValue(Ok([{...base, runAt: soon}]));
		expect((await handleGetThreadRoute(request({agentId: 'agent-1'}))).unwrap()).toMatchObject({busy: false, sleepingUntil: soon.toISOString()});

		getChatAgent.mockResolvedValue(Ok(null));
		expect((await handleGetThreadRoute(request({agentId: 'nope'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'agent'});
	});

	test('append what the person says, trimmed, and refuse nothing or too much', async () => {
		const {handlePostMessageRoute} = await import('./route');

		const posted = await handlePostMessageRoute(request({agentId: 'agent-1'}, {text: '  Hello \n'}));
		expect(appendPersonMessage).toHaveBeenCalledWith('thread-1', 'Hello');
		expect(posted.unwrap().entry).toMatchObject({id: 'e3', kind: 'person', text: 'Hello'});

		expect((await handlePostMessageRoute(request({agentId: 'agent-1'}, {text: '   '}))).unwrapErr().kind).toBe('parse_error');
		expect((await handlePostMessageRoute(request({agentId: 'agent-1'}, {text: 'x'.repeat(20_001)}))).unwrapErr().kind).toBe('parse_error');
	});
});
