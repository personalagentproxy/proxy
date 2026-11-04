import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import type {AlertRow, PollRow} from '@proxy/db/alerts';
import type {ThreadRow} from '@proxy/db/harness';

import {type FakeStore, fakeStore} from './fake-store';

// The connection's collection and its connector, as the catalog and the connectors give them.
const changes = mock();
mock.module('../records/connectors', () => ({
	connectorFor: (integrationId: string, collectionId: string) => (integrationId === 'google' && collectionId === 'emails' ? {list: mock(), get: mock(), changes} : undefined),
}));
mock.module('../utils/connection-actions', () => ({
	integrationOf: (connection: {integrationId: string}) => (connection.integrationId === 'google' ? {id: 'google', collections: [{id: 'emails', read: 'read'}]} : undefined),
}));
mock.module('@proxy/integrations', () => ({
	findCollection: (integration: {collections: Array<{id: string}>}, id: string) => integration.collections.find((collection) => collection.id === id),
	integrationFor: () => ({id: 'google', name: 'Google', collections: [{id: 'emails', read: 'read'}]}),
}));
// What the agent may read, acting as the member: the connection, with the collection's read.
const listAgentConnections = mock();
mock.module('../agent-side/tools', () => ({listAgentConnections}));

const now = new Date('2026-11-04T10:00:00Z');
const poll: PollRow = {connectionId: 'conn-a', collectionId: 'emails', cursor: 'h1'};
const connection = {
	id: 'conn-a',
	orgId: 'org-1',
	integrationId: 'google',
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
	createdAt: now,
};
const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'General', orgSlug: 'acme', experiments: []};
const watch: AlertRow = {
	id: 'alert-1',
	orgId: 'org-1',
	userId: 'user-1',
	threadId: 'thread-1',
	callId: 'c1',
	title: 'Bank',
	brief: 'Tell me.',
	at: null,
	collectionId: 'emails',
	connectionIds: ['conn-a'],
	terms: ['loan'],
	lastMatchedAt: null,
	createdAt: now,
};
const items = [
	{id: 'm1', title: 'Your loan', url: null, summary: 'From dana@bank.com'},
	{id: 'm2', title: 'Lunch?', url: null, summary: 'From sam@example.com'},
];

let store: FakeStore;

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	store.listWatches.mockResolvedValue(Ok([watch]));
	store.getPollConnection.mockResolvedValue(Ok(connection));
	store.getJobThread.mockResolvedValue(Ok(thread));
	store.getThreadAgent.mockResolvedValue(Ok(signedIn));
	store.appendEvent.mockResolvedValue(Ok(true));
	store.markAlertMatched.mockResolvedValue(Ok(undefined));
	store.setPollCursor.mockResolvedValue(Ok(undefined));
	store.deletePoll.mockResolvedValue(Ok(undefined));
	listAgentConnections.mockResolvedValue(
		Ok({
			agent: {id: 'agent-1', providerId: 'proxy', name: 'General'},
			connections: [{id: 'conn-a', integrationId: 'google', account: 'a@example.com', shared: true, actions: ['read'], tools: null, name: null}],
		}),
	);
	changes.mockResolvedValue(Ok({items, cursor: 'h2'}));
});

describe('runPoll', () => {
	test('looks at the connection since the cursor, tells each watch what matched its words, and moves the cursor on', async () => {
		const {runPoll} = await import('./watches');
		(await runPoll(store, poll, now)).unwrap();
		expect(changes).toHaveBeenCalledWith(expect.objectContaining({connection, collection: {id: 'emails', read: 'read'}}), 'h1', now);
		expect(store.appendEvent).toHaveBeenCalledTimes(1);
		const text = store.appendEvent.mock.calls[0]?.[1] ?? '';
		expect(store.appendEvent.mock.calls[0]?.[0]).toBe('thread-1');
		expect(text).toContain('Your loan');
		expect(text).not.toContain('Lunch?');
		expect(store.markAlertMatched).toHaveBeenCalledWith('alert-1', now);
		expect(store.setPollCursor).toHaveBeenCalledWith(poll, 'h2');
	});

	test('a read the agent no longer has delivers nothing, and the cursor still moves on', async () => {
		const {runPoll} = await import('./watches');
		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'proxy', name: 'General'}, connections: []}));
		(await runPoll(store, poll, now)).unwrap();
		expect(store.appendEvent).not.toHaveBeenCalled();
		expect(store.setPollCursor).toHaveBeenCalledWith(poll, 'h2');
	});

	test('a look that fails leaves the cursor where it was', async () => {
		const {runPoll} = await import('./watches');
		changes.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));
		expect((await runPoll(store, poll, now)).isErr()).toBe(true);
		expect(store.setPollCursor).not.toHaveBeenCalled();
	});

	test('no watch on it, or the connection gone: the poll deletes itself without looking', async () => {
		const {runPoll} = await import('./watches');
		store.listWatches.mockResolvedValue(Ok([]));
		(await runPoll(store, poll, now)).unwrap();
		store.listWatches.mockResolvedValue(Ok([watch]));
		store.getPollConnection.mockResolvedValue(Ok(null));
		(await runPoll(store, poll, now)).unwrap();
		expect(store.deletePoll).toHaveBeenCalledTimes(2);
		expect(changes).not.toHaveBeenCalled();
	});
});

describe('sweep', () => {
	test('takes the polls due and runs each, going on past one that fails', async () => {
		const {sweep} = await import('./watches');
		store.claimDuePolls.mockResolvedValue(Ok([poll, {...poll, connectionId: 'conn-b'}]));
		store.getPollConnection.mockResolvedValueOnce(Ok(connection)).mockResolvedValueOnce(Err(ApiErr.internalError(new Error('db down'))));
		await sweep(store, now);
		expect(store.claimDuePolls).toHaveBeenCalledWith(10 * 60 * 1000);
		expect(store.setPollCursor).toHaveBeenCalledTimes(1);
	});
});
