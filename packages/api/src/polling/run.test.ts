import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import type {PollRow} from '@proxy/db/poll';

import type {PollConsumer} from './consumer';
import {type FakePollStore, fakePollStore} from './fake-store';

// The connection's collection and its connector, as the catalog and the connectors give them.
const changes = mock();
mock.module('../records/connectors', () => ({
	connectorFor: (integrationId: string, collectionId: string) => (integrationId === 'google' && collectionId === 'emails' ? {list: mock(), changes} : undefined),
}));
mock.module('../utils/connection-actions', () => ({
	integrationOf: (connection: {integrationId: string}) => (connection.integrationId === 'google' ? {id: 'google', collections: [{id: 'emails', read: 'read'}]} : undefined),
}));
mock.module('@proxy/integrations', () => ({findCollection: (integration: {collections: Array<{id: string}>}, id: string) => integration.collections.find((collection) => collection.id === id)}));

const now = new Date('2026-11-04T10:00:00Z');
const poll: PollRow = {id: 'poll-1', orgId: 'org-1', connectionId: 'conn-a', collectionId: 'emails', cursor: 'h1', nextAt: now, claimedBy: 'w1', lastPolledAt: null, lastError: null};
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
const items = [{recordId: 'm1', title: 'Your loan', url: null, at: '2026-11-04T09:50:00Z', fields: {from: 'dana@bank.com'}}];

let store: FakePollStore;
let watches: {[K in keyof PollConsumer]: ReturnType<typeof mock<PollConsumer[K]>>};
let feed: {[K in keyof PollConsumer]: ReturnType<typeof mock<PollConsumer[K]>>};

function consumer(wants: boolean) {
	return {
		wants: mock<PollConsumer['wants']>(async () => Ok(wants)),
		handle: mock<PollConsumer['handle']>(async () => Ok(undefined)),
		connectionGone: mock<PollConsumer['connectionGone']>(async () => Ok(undefined)),
	};
}

beforeEach(() => {
	mock.clearAllMocks();
	store = fakePollStore();
	store.getPollConnection.mockResolvedValue(Ok(connection));
	store.deletePoll.mockResolvedValue(Ok(undefined));
	store.finishPoll.mockResolvedValue(Ok(true));
	store.logPoll.mockResolvedValue(Ok(undefined));
	changes.mockResolvedValue(Ok({items, cursor: 'h2'}));
	watches = consumer(true);
	feed = consumer(false);
});

describe('runPoll', () => {
	test('looks at the connection since the cursor, hands what it found to every consumer, logs the look, and finishes with the cursor and the next look', async () => {
		const {runPoll} = await import('./run');
		(await runPoll(store, [watches, feed], poll, 'w1', now)).unwrap();

		expect(changes).toHaveBeenCalledWith(expect.objectContaining({connection, collection: {id: 'emails', read: 'read'}}), 'h1', now);
		expect(store.logPoll).toHaveBeenCalledWith({orgId: 'org-1', connectionId: 'conn-a', collectionId: 'emails', action: 'list', recordTitle: null, ownerUserId: null, userId: null});
		expect(watches.handle).toHaveBeenCalledWith(poll, items);
		expect(feed.handle).toHaveBeenCalledWith(poll, items);
		expect(store.finishPoll).toHaveBeenCalledWith('poll-1', 'w1', {cursor: 'h2', nextAt: new Date('2026-11-04T10:10:00Z'), error: null});
	});

	test('a consumer that fails leaves the cursor where it was, so the look comes again', async () => {
		const {runPoll} = await import('./run');
		watches.handle.mockResolvedValue(Err(ApiErr.internalError(new Error('db down'))));

		expect((await runPoll(store, [watches], poll, 'w1', now)).isErr()).toBe(true);
		expect(store.finishPoll).not.toHaveBeenCalled();
	});

	test('a look that fails is noted, the cursor kept, and no consumer told', async () => {
		const {runPoll} = await import('./run');
		changes.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('down'))));

		(await runPoll(store, [watches], poll, 'w1', now)).unwrap();

		expect(store.finishPoll).toHaveBeenCalledWith('poll-1', 'w1', {cursor: 'h1', nextAt: new Date('2026-11-04T10:10:00Z'), error: 'down'});
		expect(store.logPoll).not.toHaveBeenCalled();
		expect(watches.handle).not.toHaveBeenCalled();
	});

	test('no consumer wants it: the poll deletes itself without looking', async () => {
		const {runPoll} = await import('./run');

		(await runPoll(store, [feed], poll, 'w1', now)).unwrap();

		expect(store.deletePoll).toHaveBeenCalledWith('poll-1');
		expect(changes).not.toHaveBeenCalled();
		expect(store.finishPoll).not.toHaveBeenCalled();
	});

	test('the connection gone: every consumer is told, and the poll deletes itself', async () => {
		const {runPoll} = await import('./run');
		store.getPollConnection.mockResolvedValue(Ok(null));

		(await runPoll(store, [watches, feed], poll, 'w1', now)).unwrap();

		expect(watches.connectionGone).toHaveBeenCalledWith(poll);
		expect(feed.connectionGone).toHaveBeenCalledWith(poll);
		expect(store.deletePoll).toHaveBeenCalledWith('poll-1');
		expect(changes).not.toHaveBeenCalled();
	});
});
