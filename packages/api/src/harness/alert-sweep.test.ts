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
// A connection whose sign-in was turned down needs signing in to again; a turned-down look is noted.
mock.module('../connections/unavailable', () => ({needsSignIn: (connection: {credentialRejectedAt: Date | null}) => connection.credentialRejectedAt !== null}));
const noteRejectedSignIn = mock(async (_connection: unknown, _credential: string | null, answer: unknown) => answer);
mock.module('../connections/rejected-sign-in', () => ({noteRejectedSignIn}));
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
	credentialRejectedAt: null,
	credential: 'secret',
};
const thread: ThreadRow = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'agent-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: 'chat-1',
	subAgentOfId: null,
	parentCallId: null,
	title: 'Invoices from the bank',
	taskId: 'task-1',
	harness: null,
	harnessSession: null,
	openedByAlert: false,
	createdAt: now,
};
const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'General', orgSlug: 'acme', experiments: []};
const watch: AlertRow = {
	id: 'alert-1',
	orgId: 'org-1',
	userId: 'user-1',
	chatId: 'chat-1',
	threadId: 'thread-1',
	setInThreadId: 'thread-1',
	title: 'Bank',
	brief: 'Tell me.',
	at: null,
	nextAt: null,
	every: null,
	timeZone: null,
	collectionId: 'emails',
	connectionIds: ['conn-a'],
	terms: ['loan'],
	split: null,
	lastMatchedAt: null,
	slackAppId: null,
	slackChannel: null,
	createdAt: now,
};
const items = [
	{id: 'm1', title: 'Your loan', url: null, summary: 'From dana@bank.com'},
	{id: 'm2', title: 'Lunch?', url: null, summary: 'From sam@example.com'},
];

const timed: AlertRow = {...watch, id: 'alert-2', title: 'Call Dana', brief: 'Remind them.', at: now, nextAt: now, collectionId: null, connectionIds: [], terms: []};
const chat: ThreadRow = {...thread, id: 'chat-1', parentThreadId: null, title: null, taskId: null};

// The threads by id: the chat, the thread the alerts were set in, and any other.
function threadById(id: string): ThreadRow {
	if (id === 'chat-1') {
		return chat;
	}
	return {...thread, id};
}

let store: FakeStore;

beforeEach(() => {
	mock.clearAllMocks();
	store = fakeStore();
	store.listWatches.mockResolvedValue(Ok([watch]));
	store.getPollConnection.mockResolvedValue(Ok(connection));
	store.getJobThread.mockImplementation(async (id) => Ok(threadById(id)));
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
		(await runPoll(store, poll, now)).unwrap();
		expect(changes).toHaveBeenCalledTimes(1);
		expect(changes).toHaveBeenCalledWith(expect.objectContaining({connection, collection: {id: 'emails', read: 'read'}}), 'h1', now);
		expect(store.recordLook).toHaveBeenCalledTimes(1);
		const [looked, cursor, matched, at] = store.recordLook.mock.calls[0] ?? [];
		expect([looked, cursor, at]).toEqual([poll, 'h2', now]);
		expect(matched).toHaveLength(1);
		expect(matched?.[0]?.alert).toBe(watch);
		expect(matched?.[0]?.landings).toHaveLength(1);
		expect(matched?.[0]?.landings[0]?.opening).toBeNull();
		expect(matched?.[0]?.landings[0]?.text).toContain('Your loan');
		expect(matched?.[0]?.landings[0]?.text).not.toContain('Lunch?');

		store.listWatches.mockResolvedValue(Ok([watch, other]));
		(await runPoll(store, poll, now)).unwrap();
		expect(changes).toHaveBeenCalledTimes(2);
		const both = store.recordLook.mock.calls[1]?.[2] ?? [];
		expect(both.map(({alert, landings}) => [alert.id, landings[0]?.text.includes('Lunch?')])).toEqual([
			['alert-1', false],
			['alert-3', true],
		]);
	});

	test('a watch that opens new threads opens one in its chat for the look, or one for each record, titled with it, telling where it was set', async () => {
		const {runPoll} = await import('./alert-sweep');
		const everything = {...watch, threadId: null, terms: [], split: 'per_check' as const};
		store.listWatches.mockResolvedValue(Ok([everything]));
		(await runPoll(store, poll, now)).unwrap();
		const [look] = store.recordLook.mock.calls[0]?.[2] ?? [];
		expect(look?.landings).toHaveLength(1);
		expect(look?.landings[0]?.text).toContain('Your loan');
		expect(look?.landings[0]?.text).toContain('Lunch?');
		expect(look?.landings[0]?.text).toContain('You set it in the thread “Invoices from the bank” (id thread-1).');
		expect(look?.landings[0]?.opening).toEqual({
			title: 'Bank',
			task: {orgId: 'org-1', agentId: 'agent-1', ownerUserId: 'user-1', personaId: 'persona-1', parentId: null, title: 'Bank', goal: 'Tell me.', via: 'harness'},
		});

		store.listWatches.mockResolvedValue(Ok([{...everything, split: 'per_record' as const}]));
		(await runPoll(store, poll, now)).unwrap();
		const [each] = store.recordLook.mock.calls[1]?.[2] ?? [];
		expect(each?.landings.map((landing) => landing.opening?.title)).toEqual(['Bank: Your loan', 'Bank: Lunch?']);
		expect(each?.landings[1]?.text).not.toContain('Your loan');
	});

	test('a watch that opens a thread for each record opens ten at most for a look, the rest together in the tenth', async () => {
		const {runPoll} = await import('./alert-sweep');
		store.listWatches.mockResolvedValue(Ok([{...watch, threadId: null, terms: [], split: 'per_record' as const}]));
		const many = Array.from({length: 14}, (_, index) => ({id: `m${index}`, title: `Mail ${index}`, url: null, summary: ''}));
		changes.mockResolvedValue(Ok({items: many, cursor: 'h2'}));
		(await runPoll(store, poll, now)).unwrap();
		const [look] = store.recordLook.mock.calls[0]?.[2] ?? [];
		expect(look?.landings).toHaveLength(10);
		expect(look?.landings[9]?.opening?.title).toBe('Bank');
		expect(look?.landings[9]?.text).toContain('5 new emails');
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

	test('a connection whose sign-in was turned down is not looked at, and the next comes again from the cursor', async () => {
		const {runPoll} = await import('./alert-sweep');
		store.getPollConnection.mockResolvedValue(Ok({...connection, credentialRejectedAt: now}));
		(await runPoll(store, poll, now)).unwrap();
		expect(changes).not.toHaveBeenCalled();
		expect(store.recordLook).not.toHaveBeenCalled();
	});

	test('a look its provider turns the sign-in down for is noted on the connection with the credential it used', async () => {
		const {runPoll} = await import('./alert-sweep');
		const rejected = Err(ApiErr.credentialsRejected());
		changes.mockResolvedValue(rejected);
		expect((await runPoll(store, poll, now)).isErr()).toBe(true);
		expect(noteRejectedSignIn).toHaveBeenCalledWith(connection, 'secret', rejected);
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
		expect(store.fireAlert).toHaveBeenCalledWith(
			timed,
			{text: 'The alert “Call Dana” is due now, which you set for 2026-11-04T10:00:00.000Z. What you noted for it: Remind them.', opening: null},
			null,
		);
		expect(store.recordLook).toHaveBeenCalledTimes(1);
	});

	test('a timed alert that opens new threads opens one in its chat, and one that repeats is due again at its next time', async () => {
		const {fireDue} = await import('./alert-sweep');
		const own = {...timed, threadId: null};
		(await fireDue(store, own, now)).unwrap();
		expect(store.fireAlert).toHaveBeenLastCalledWith(
			own,
			{
				text: 'The alert “Call Dana” is due now, which you set for 2026-11-04T10:00:00.000Z. You set it in the thread “Invoices from the bank” (id thread-1). What you noted for it: Remind them.',
				opening: {title: 'Call Dana', task: expect.objectContaining({title: 'Call Dana', goal: 'Remind them.', parentId: null})},
			},
			null,
		);

		// Weekdays at 11 in Berlin, 10:00 UTC in November: next on Thursday.
		const weekdays = {...own, every: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=11;BYMINUTE=0', timeZone: 'Europe/Berlin'};
		(await fireDue(store, weekdays, now)).unwrap();
		expect(store.fireAlert.mock.calls.at(-1)?.[2]).toEqual(new Date('2026-11-05T10:00:00Z'));
	});

	test('a timed alert that cannot fire leaves the polls to be looked at', async () => {
		const {sweep} = await import('./alert-sweep');
		store.claimDueAlerts.mockResolvedValue(Err(ApiErr.dbError(new Error('db down'))));
		store.claimDuePolls.mockResolvedValue(Ok([poll]));
		await sweep(store);
		expect(store.recordLook).toHaveBeenCalledTimes(1);
	});
});
