import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {AlertRow, ThreadRow} from '@proxy/db/harness';
import type {PollRow} from '@proxy/db/poll';

import {type FakeStore, fakeStore} from './fake-store';

const watchableConnections = mock();
mock.module('./watch-connections', () => ({watchableConnections}));

const now = new Date('2026-11-04T10:00:00Z');
const poll: PollRow = {id: 'poll-1', orgId: 'org-1', connectionId: 'conn-a', collectionId: 'emails', cursor: 'h1', nextAt: now, claimedBy: 'w1', lastPolledAt: null, lastError: null};
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
	finishedAt: null,
	createdAt: now,
};
const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Chat', orgSlug: 'acme', experiments: []};

function watch(id: string, criteria: string, threadId = 'thread-1'): AlertRow {
	return {
		id,
		orgId: 'org-1',
		agentId: 'agent-1',
		personaId: 'persona-1',
		userId: 'user-1',
		threadId,
		title: id,
		brief: 'Brief.',
		at: null,
		collectionId: 'emails',
		connectionIds: ['conn-a'],
		criteria,
		endedAt: null,
		endedBy: null,
		createdAt: now,
	};
}

const bank = watch('bank', '[{"field":"from","terms":["@bank.com"]}]');
const anything = watch('anything', '[]', 'thread-2');
const loan = {recordId: 'm1', title: 'Your loan', url: 'https://mail.example/m1', at: '2026-11-04T09:50:00Z', fields: {from: 'dana@bank.com', subject: 'Your loan'}};
const other = {recordId: 'm2', title: 'Lunch', url: null, at: '2026-11-04T09:55:00Z', fields: {from: 'sam@example.com', subject: 'Lunch'}};

let store: FakeStore;

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	store.listWatches.mockResolvedValue(Ok([bank, anything]));
	store.landMatches.mockResolvedValue(Ok(undefined));
	store.dropConnectionFromWatches.mockResolvedValue(Ok(undefined));
	store.getJobThread.mockImplementation(async (threadId: string) => Ok({...thread, id: threadId}));
	store.getThreadAgent.mockResolvedValue(Ok(signedIn));
	watchableConnections.mockResolvedValue(Ok([{id: 'conn-a', name: 'Gmail'}]));
});

describe('the watches, as what polling looks for', () => {
	test('want a connection’s collection looked at while any watch is on it', async () => {
		const {watchConsumer} = await import('./watches');
		expect((await watchConsumer(store).wants(poll)).unwrap()).toBe(true);
		store.listWatches.mockResolvedValue(Ok([]));
		expect((await watchConsumer(store).wants(poll)).unwrap()).toBe(false);
	});

	test('match what a look found against each watch, and land the matches with what is kept of each record', async () => {
		const {watchConsumer} = await import('./watches');
		(await watchConsumer(store).handle(poll, [loan, other])).unwrap();

		expect(store.landMatches).toHaveBeenCalledWith(poll, [
			{alert: bank, items: [{...loan, summary: 'from: dana@bank.com · subject: Your loan'}]},
			{
				alert: anything,
				items: [
					{...loan, summary: 'from: dana@bank.com · subject: Your loan'},
					{...other, summary: 'from: sam@example.com · subject: Lunch'},
				],
			},
		]);
	});

	test('a watch whose agent may no longer read the connection is told nothing; a look that found nothing lands nothing', async () => {
		const {watchConsumer} = await import('./watches');
		store.getThreadAgent.mockImplementation(async (one: ThreadRow) => Ok({...signedIn, ownerUserId: one.id === 'thread-2' ? 'user-2' : 'user-1'}));
		watchableConnections.mockImplementation(async (agent: {ownerUserId: string}) => Ok(agent.ownerUserId === 'user-2' ? [{id: 'conn-a', name: 'Gmail'}] : []));

		(await watchConsumer(store).handle(poll, [loan, other])).unwrap();
		expect(store.landMatches.mock.calls[0]?.[1].map((match) => match.alert.id)).toEqual(['anything']);

		store.landMatches.mockClear();
		(await watchConsumer(store).handle(poll, [])).unwrap();
		expect(store.landMatches).not.toHaveBeenCalled();
	});

	test('a connection gone ends the watches left watching nothing', async () => {
		const {watchConsumer} = await import('./watches');
		(await watchConsumer(store).connectionGone(poll)).unwrap();
		expect(store.dropConnectionFromWatches).toHaveBeenCalledWith('conn-a', 'emails', expect.any(Function));
	});
});
