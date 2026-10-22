import {afterEach, beforeEach, describe, expect, mock, setSystemTime, test} from 'bun:test';
import {Ok} from 'ts-results-es';

const getUserOrgId = mock();
const listAuditEntries = mock();
const summarizeTaskRequests = mock();

mock.module('@proxy/db/organization', () => ({getUserOrgId}));
mock.module('@proxy/db/audit', () => ({listAuditEntries, summarizeTaskRequests}));

const listAgentTasks = mock();
const listAgentTasksSince = mock();

mock.module('@proxy/db/task', () => ({listAgentTasks, listAgentTasksSince}));

function makeRequest(query: Record<string, string>) {
	return {user: {userId: 'user-1', email: 'test@example.com', name: 'Test User'}, query};
}

beforeEach(() => {
	mock.clearAllMocks();
	getUserOrgId.mockResolvedValue(Ok('org-1'));
	listAuditEntries.mockResolvedValue(Ok([]));
	listAgentTasks.mockResolvedValue(Ok([]));
	listAgentTasksSince.mockResolvedValue(Ok([]));
	summarizeTaskRequests.mockResolvedValue(Ok([]));
	setSystemTime(new Date('2026-10-15T23:30:00Z'));
});

afterEach(() => {
	setSystemTime();
});

describe('handleActivityLanesRoute', () => {
	test('answers the tasks under way since the time asked for, with what was done for each', async () => {
		const task = {
			id: 'task-1',
			agentId: 'agent-1',
			parentId: null,
			title: 'Triage inbox',
			goal: 'Archive the newsletters',
			via: 'mcp',
			createdAt: new Date('2026-10-15T20:00:00Z'),
			finishedAt: null,
			outcome: null,
		};
		listAgentTasksSince.mockResolvedValue(Ok([task]));
		summarizeTaskRequests.mockResolvedValue(
			Ok([
				{taskId: 'task-1', connectionId: 'notion-1', outcome: 'allowed', count: 5, first: new Date('2026-10-15T20:05:00Z')},
				{taskId: 'task-1', connectionId: 'mail-1', outcome: 'allowed', count: 3, first: new Date('2026-10-15T20:01:00Z')},
				{taskId: 'task-1', connectionId: 'mail-1', outcome: 'denied', count: 1, first: new Date('2026-10-15T20:40:00Z')},
			]),
		);
		const {handleActivityLanesRoute} = await import('./route');
		const result = await handleActivityLanesRoute(makeRequest({from: '2026-10-14T23:30:00Z'}) as never);

		expect(listAgentTasksSince).toHaveBeenCalledWith('org-1', new Date('2026-10-14T23:30:00Z'), 200);
		expect(summarizeTaskRequests).toHaveBeenCalledWith('org-1', ['task-1']);
		expect(result.unwrap()).toEqual({
			now: '2026-10-15T23:30:00.000Z',
			from: '2026-10-14T23:30:00.000Z',
			tasks: [
				{
					id: 'task-1',
					agentId: 'agent-1',
					parentId: null,
					title: 'Triage inbox',
					goal: 'Archive the newsletters',
					via: 'mcp',
					startedAt: '2026-10-15T20:00:00.000Z',
					finishedAt: null,
					outcome: null,
					requests: 9,
					denied: 1,
					// Notion was used most, though the mailbox came first.
					connectionIds: ['notion-1', 'mail-1'],
				},
			],
		});
	});

	test('a window further back than a month is cut to one, and a time that is not one is refused', async () => {
		const {handleActivityLanesRoute} = await import('./route');
		await handleActivityLanesRoute(makeRequest({from: '2020-01-01T00:00:00Z'}) as never);
		const bad = await handleActivityLanesRoute(makeRequest({from: 'yesterday'}) as never);

		expect(listAgentTasksSince).toHaveBeenCalledWith('org-1', new Date('2026-09-14T23:30:00Z'), 200);
		expect(bad.unwrapErr().kind).toBe('parse_error');
	});
});

describe('handleListActivityRoute', () => {
	test('narrows to one outcome', async () => {
		const {handleListActivityRoute} = await import('./route');
		await handleListActivityRoute(makeRequest({outcome: 'denied'}) as never);

		expect(listAuditEntries).toHaveBeenCalledWith('org-1', {outcome: 'denied'}, 500);
	});

	test('what Personal Agent Proxy did itself is the entries without an agent', async () => {
		const {handleListActivityRoute} = await import('./route');
		await handleListActivityRoute(makeRequest({agentId: 'proxy'}) as never);

		expect(listAuditEntries).toHaveBeenCalledWith('org-1', {agentId: null}, 500);
	});

	test('names the tasks the entries were made for, and the one asked for even without entries', async () => {
		const entry = {
			id: 'e1',
			agentId: 'agent-1',
			connectionId: 'c1',
			collectionId: 'emails',
			action: 'list',
			recordTitle: null,
			query: null,
			outcome: 'allowed',
			via: 'mcp',
			taskId: 'task-1',
			durationMs: 340,
			error: null,
			createdAt: new Date('2026-10-15T10:00:00Z'),
		};
		listAuditEntries.mockResolvedValue(Ok([entry, {...entry, id: 'e2', taskId: null, agentId: null, durationMs: null}]));
		listAgentTasks.mockResolvedValue(
			Ok([
				{
					id: 'task-1',
					agentId: 'agent-1',
					parentId: 'task-0',
					title: 'Triage inbox',
					goal: 'Archive the newsletters',
					via: 'mcp',
					createdAt: new Date('2026-10-15T09:00:00Z'),
					finishedAt: new Date('2026-10-15T09:30:00Z'),
					outcome: 'Archived 12 newsletters',
				},
			]),
		);
		const {handleListActivityRoute} = await import('./route');
		const result = await handleListActivityRoute(makeRequest({taskId: 'task-2'}) as never);

		expect(listAuditEntries).toHaveBeenCalledWith('org-1', {taskId: 'task-2'}, 500);
		expect(listAgentTasks).toHaveBeenCalledWith('org-1', ['task-1', 'task-2']);
		expect(result.unwrap()).toEqual({
			entries: [
				{
					id: 'e1',
					agentId: 'agent-1',
					connectionId: 'c1',
					collectionId: 'emails',
					action: 'list',
					recordTitle: null,
					query: null,
					outcome: 'allowed',
					via: 'mcp',
					taskId: 'task-1',
					durationMs: 340,
					error: null,
					at: '2026-10-15T10:00:00.000Z',
				},
				{
					id: 'e2',
					agentId: null,
					connectionId: 'c1',
					collectionId: 'emails',
					action: 'list',
					recordTitle: null,
					query: null,
					outcome: 'allowed',
					via: 'mcp',
					taskId: null,
					durationMs: null,
					error: null,
					at: '2026-10-15T10:00:00.000Z',
				},
			],
			tasks: [
				{
					id: 'task-1',
					agentId: 'agent-1',
					parentId: 'task-0',
					title: 'Triage inbox',
					goal: 'Archive the newsletters',
					via: 'mcp',
					startedAt: '2026-10-15T09:00:00.000Z',
					finishedAt: '2026-10-15T09:30:00.000Z',
					outcome: 'Archived 12 newsletters',
				},
			],
		});
	});
});
