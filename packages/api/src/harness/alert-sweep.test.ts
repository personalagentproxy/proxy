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
	ownerUserId: 'user-1',
	sharedWithEveryone: true,
	shares: [],
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
	harness: null,
	harnessSession: null,
	createdAt: now,
};
const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'General', orgSlug: 'acme', experiments: []};
const watch: AlertRow = {
	id: 'alert-1',
	orgId: 'org-1',
	userId: 'user-1',
	threadId: 'thread-1',
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

const timed: AlertRow = {...watch, id: 'alert-2', title: 'Call Dana', brief: 'Remind them.', at: now, collectionId: null, connectionIds: [], terms: []};

let store: FakeStore;

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	store.listWatches.mockResolvedValue(Ok([watch]));
	store.getPollConnection.mockResolvedValue(Ok(connection));
	store.getJobThread.mockResolvedValue(Ok(thread));
	store.getThreadAgent.mockResolvedValue(Ok(signedIn));
	store.recordLook.mockResolvedValue(Ok(true));
	store.fireAlert.mockResolvedValue(Ok(true));
	store.claimDueAlerts.mockResolvedValue(Ok([]));
	store.claimDuePolls.mockResolvedValue(Ok([]));
	listAgentConnections.mockResolvedValue(
		Ok({
			agent: {id: 'agent-1', providerId: 'proxy', name: 'General'},
			connections: [{id: 'conn-a', integrationId: 'google', account: 'a@example.com', shared: true, actions: ['read'], tools: null, name: null}],
		}),
	);
	changes.mockResolvedValue(Ok({items, cursor: 'h2'}));
});

describe('runPoll', () => {
	test('reads the connection once since the cursor, and notes the new cursor with what matched each watch’s words', async () => {
		const {runPoll} = await import('./alert-sweep');
		const other: AlertRow = {...watch, id: 'alert-3', threadId: 'thread-2', terms: ['lunch']};
		store.getJobThread.mockImplementation(async (id) => Ok({...thread, id}));
		(await runPoll(store, poll, now)).unwrap();
		expect(changes).toHaveBeenCalledTimes(1);
		expect(changes).toHaveBeenCalledWith(expect.objectContaining({connection, collection: {id: 'emails', read: 'read'}}), 'h1', now);
		expect(store.recordLook).toHaveBeenCalledTimes(1);
		const [looked, cursor, matched, at] = store.recordLook.mock.calls[0] ?? [];
		expect([looked, cursor, at]).toEqual([poll, 'h2', now]);
		expect(matched).toHaveLength(1);
		expect(matched?.[0]?.alert).toBe(watch);
		expect(matched?.[0]?.text).toContain('Your loan');
		expect(matched?.[0]?.text).not.toContain('Lunch?');

		store.listWatches.mockResolvedValue(Ok([watch, other]));
		(await runPoll(store, poll, now)).unwrap();
		expect(changes).toHaveBeenCalledTimes(2);
		const both = store.recordLook.mock.calls[1]?.[2] ?? [];
		expect(both.map(({alert, text}) => [alert.id, text.includes('Lunch?')])).toEqual([
			['alert-1', false],
			['alert-3', true],
		]);
	});

	test('a read the agent no longer has tells that watch nothing, and the cursor still moves on', async () => {
		const {runPoll} = await import('./alert-sweep');
		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'proxy', name: 'General'}, connections: []}));
		(await runPoll(store, poll, now)).unwrap();
		expect(store.recordLook).toHaveBeenCalledWith(poll, 'h2', [], now);
	});

	test('a look that fails, or a check of the read that fails, notes nothing, so the next comes again from the cursor', async () => {
		const {runPoll} = await import('./alert-sweep');
		changes.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));
		expect((await runPoll(store, poll, now)).isErr()).toBe(true);

		changes.mockResolvedValue(Ok({items, cursor: 'h2'}));
		listAgentConnections.mockResolvedValue(Err(ApiErr.dbError(new Error('db down'))));
		expect((await runPoll(store, poll, now)).isErr()).toBe(true);

		store.getPollConnection.mockResolvedValue(Ok(null));
		expect((await runPoll(store, poll, now)).isErr()).toBe(true);
		expect(store.recordLook).not.toHaveBeenCalled();
	});

	test('a poll whose last watch went since it was taken is not looked at', async () => {
		const {runPoll} = await import('./alert-sweep');
		store.listWatches.mockResolvedValue(Ok([]));
		(await runPoll(store, poll, now)).unwrap();
		expect(changes).not.toHaveBeenCalled();
		expect(store.recordLook).not.toHaveBeenCalled();
	});
});

describe('sweep', () => {
	test('fires the timed alerts due with what the agent noted, then looks at each poll due, going on past one that fails', async () => {
		const {sweep} = await import('./alert-sweep');
		store.claimDueAlerts.mockResolvedValue(Ok([timed]));
		store.claimDuePolls.mockResolvedValue(Ok([poll, {...poll, connectionId: 'conn-b'}]));
		store.getPollConnection.mockResolvedValueOnce(Ok(connection)).mockResolvedValueOnce(Err(ApiErr.dbError(new Error('db down'))));
		await sweep(store);
		expect(store.claimDueAlerts).toHaveBeenCalledWith(10 * 60 * 1000, 50);
		expect(store.claimDuePolls).toHaveBeenCalledWith(10 * 60 * 1000, 50);
		expect(store.fireAlert).toHaveBeenCalledWith(timed, 'The alert “Call Dana” is due now, which you set for 2026-11-04T10:00:00.000Z. What you noted for it: Remind them.');
		expect(store.recordLook).toHaveBeenCalledTimes(1);
	});

	test('a timed alert that cannot fire leaves the polls to be looked at', async () => {
		const {sweep} = await import('./alert-sweep');
		store.claimDueAlerts.mockResolvedValue(Err(ApiErr.dbError(new Error('db down'))));
		store.claimDuePolls.mockResolvedValue(Ok([poll]));
		await sweep(store);
		expect(store.recordLook).toHaveBeenCalledTimes(1);
	});
});
