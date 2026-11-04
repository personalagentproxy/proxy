import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import type {AlertRow, PollRow, ThreadRow} from '@proxy/db/harness';

import {type FakeStore, fakeStore} from './fake-store';

// The connection's collection and its connector, as the catalog and the connectors give them.
const changes = mock();
mock.module('../records/connectors', () => ({
	connectorFor: (integrationId: string, collectionId: string) => (integrationId === 'gmail' && collectionId === 'emails' ? {list: mock(), changes} : undefined),
}));
mock.module('../utils/connection-actions', () => ({
	integrationOf: (connection: {integrationId: string}) => (connection.integrationId === 'gmail' ? {id: 'gmail', collections: [{id: 'emails', read: 'read'}]} : undefined),
}));
mock.module('@proxy/integrations', () => ({findCollection: (integration: {collections: Array<{id: string}>}, id: string) => integration.collections.find((collection) => collection.id === id)}));
const watchableConnections = mock();
mock.module('./watch-connections', () => ({watchableConnections}));

const now = new Date('2026-11-04T10:00:00Z');
const poll: PollRow = {id: 'poll-1', orgId: 'org-1', connectionId: 'conn-a', collectionId: 'emails', cursor: 'h1', nextAt: now, claimedBy: 'w1', lastPolledAt: null, lastError: null};
const connection = {
	id: 'conn-a',
	orgId: 'org-1',
	integrationId: 'gmail',
	account: 'a@example.com',
	ownerUserId: null,
	connectedById: 'user-1',
	createdAt: now,
	tools: null,
	name: null,
	defaults: [],
	credential: 'secret',
};
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

function rule(id: string, criteria: string, threadId = 'thread-1'): AlertRow {
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

const bank = rule('bank', '[{"field":"from","terms":["@bank.com"]}]');
const anything = rule('anything', '[]', 'thread-2');
const loan = {recordId: 'm1', title: 'Your loan', url: 'https://mail.example/m1', at: '2026-11-04T09:50:00Z', fields: {from: 'dana@bank.com', subject: 'Your loan'}};
const other = {recordId: 'm2', title: 'Lunch', url: null, at: '2026-11-04T09:55:00Z', fields: {from: 'sam@example.com', subject: 'Lunch'}};

let store: FakeStore;

beforeEach(async () => {
	mock.clearAllMocks();
	store = fakeStore();
	store.listPollRules.mockResolvedValue(Ok([bank, anything]));
	store.getPollConnection.mockResolvedValue(Ok(connection));
	store.deletePoll.mockResolvedValue(Ok(undefined));
	store.finishPoll.mockResolvedValue(Ok(true));
	store.dropConnectionFromWatches.mockResolvedValue(Ok(undefined));
	store.logPoll.mockResolvedValue(Ok(undefined));
	store.getJobThread.mockImplementation(async (threadId: string) => Ok({...thread, id: threadId}));
	store.getThreadAgent.mockResolvedValue(Ok(signedIn));
	watchableConnections.mockResolvedValue(Ok([{id: 'conn-a', name: 'Gmail'}]));
	changes.mockResolvedValue(Ok({items: [loan, other], cursor: 'h2'}));
});

describe('runPoll', () => {
	test('looks at the connection since the cursor, matches what is new against each watch, and finishes with the matches, the cursor and the next look', async () => {
		const {runPoll} = await import('./poll');
		(await runPoll(store, poll, 'w1', now)).unwrap();

		expect(changes).toHaveBeenCalledWith(expect.objectContaining({connection, collection: {id: 'emails', read: 'read'}}), 'h1', now);
		expect(store.logPoll).toHaveBeenCalledWith({orgId: 'org-1', connectionId: 'conn-a', collectionId: 'emails', action: 'list', recordTitle: null, ownerUserId: null, userId: null});
		expect(store.finishPoll).toHaveBeenCalledWith('poll-1', 'w1', {
			cursor: 'h2',
			nextAt: new Date('2026-11-04T10:10:00Z'),
			error: null,
			matches: [
				{alert: bank, items: [{...loan, summary: 'from: dana@bank.com · subject: Your loan'}]},
				{
					alert: anything,
					items: [
						{...loan, summary: 'from: dana@bank.com · subject: Your loan'},
						{...other, summary: 'from: sam@example.com · subject: Lunch'},
					],
				},
			],
		});
	});

	test('a watch whose agent may no longer read the connection is told nothing', async () => {
		const {runPoll} = await import('./poll');
		watchableConnections.mockImplementation(async (agent: {ownerUserId: string}) => Ok(agent.ownerUserId === 'user-1' ? [] : []));
		store.getThreadAgent.mockImplementation(async (one: ThreadRow) => Ok({...signedIn, ownerUserId: one.id === 'thread-2' ? 'user-2' : 'user-1'}));
		watchableConnections.mockImplementation(async (agent: {ownerUserId: string}) => Ok(agent.ownerUserId === 'user-2' ? [{id: 'conn-a', name: 'Gmail'}] : []));

		(await runPoll(store, poll, 'w1', now)).unwrap();

		const outcome = store.finishPoll.mock.calls[0]?.[2];
		expect(outcome?.matches.map((match) => match.alert.id)).toEqual(['anything']);
	});

	test('a look that fails is noted, the cursor kept, and nothing matched', async () => {
		const {runPoll} = await import('./poll');
		changes.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));

		(await runPoll(store, poll, 'w1', now)).unwrap();

		expect(store.finishPoll).toHaveBeenCalledWith('poll-1', 'w1', {cursor: 'h1', nextAt: new Date('2026-11-04T10:10:00Z'), error: 'down', matches: []});
		expect(store.logPoll).not.toHaveBeenCalled();
	});

	test('no watch left on it: the poll deletes itself', async () => {
		const {runPoll} = await import('./poll');
		store.listPollRules.mockResolvedValue(Ok([]));

		(await runPoll(store, poll, 'w1', now)).unwrap();

		expect(store.deletePoll).toHaveBeenCalledWith('poll-1');
		expect(changes).not.toHaveBeenCalled();
		expect(store.finishPoll).not.toHaveBeenCalled();
	});

	test('the connection gone: the watches are told, and the poll deletes itself', async () => {
		const {runPoll} = await import('./poll');
		store.getPollConnection.mockResolvedValue(Ok(null));

		(await runPoll(store, poll, 'w1', now)).unwrap();

		expect(store.dropConnectionFromWatches).toHaveBeenCalledWith('conn-a', 'emails', expect.any(Function));
		expect(store.deletePoll).toHaveBeenCalledWith('poll-1');
	});
});
