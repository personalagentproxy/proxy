import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';
import type {MemberAlertRow} from '@proxy/db/alerts';
import type {MemberThreadRow} from '@proxy/db/chat';
import type {ChatThreadRow} from '@proxy/db/harness';

mock.module('../../utils/env', () => ({env: {APP_URL: 'https://app.example.test'}}));

const listMemberThreads = mock();
const getThreadPlace = mock();
const getOrgSlug = mock();
mock.module('@proxy/db/chat', () => ({listMemberThreads, getThreadPlace, getOrgSlug}));

const getMemberThread = mock();
mock.module('@proxy/db/harness', () => ({getMemberThread}));

const listMemberAlerts = mock();
const deleteAlert = mock();
mock.module('@proxy/db/alerts', () => ({listMemberAlerts, deleteAlert}));

function collection(id: string): Collection {
	const integration = findIntegration('chat');
	const found = integration && findCollection(integration, id);
	if (!found) {
		throw new Error(`No ${id} collection`);
	}
	return found;
}

const connection = {
	id: 'chat-1',
	integrationId: 'chat',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	sharedWithEveryone: false,
	shares: [],
	account: 'Acme',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [],
	credentialRejectedAt: null,
	credential: null,
};
const threads = {connection, collection: collection('threads')};
const alerts = {connection, collection: collection('alerts')};
const all = {search: null, page: null, filter: null, parent: null};

const at = (minute: number) => new Date(Date.UTC(2026, 9, 21, 10, minute));

// A thread as a list of the member's has it: stopped, waiting for them, its summary current.
function listed(over: Partial<MemberThreadRow> = {}): MemberThreadRow {
	return {
		id: 'thread-1',
		personaId: 'persona-1',
		personaName: 'Finance',
		title: 'Pricing review with Dana',
		createdAt: at(0),
		state: {kind: 'stopped'},
		standing: {waitingForMember: true, summary: 'Asks which day suits Dana.', summarySeq: 2},
		last: {seq: 2, pending: false, createdAt: at(2)},
		...over,
	};
}

beforeEach(() => {
	mock.clearAllMocks();
	listMemberThreads.mockResolvedValue(Ok({orgSlug: 'acme', threads: [listed()]}));
	getThreadPlace.mockResolvedValue(Ok({orgSlug: 'acme', personaName: 'Finance'}));
	getOrgSlug.mockResolvedValue(Ok('acme'));
});

describe('the Chat connection’s threads', () => {
	test('are the member’s, whoever reads them through the connection, each with whom it is with, where it stands, its summary and its page in Chat', async () => {
		const {threadsConnector} = await import('./connector');

		const page = (await threadsConnector.list(threads, all)).unwrap();

		expect(listMemberThreads).toHaveBeenCalledWith('org-1', 'user-1', {search: null, standing: null, skip: 0, take: 51});
		expect(page).toEqual({
			records: [
				{
					id: 'thread-1',
					values: {
						title: 'Pricing review with Dana',
						agent: 'Finance',
						standing: 'Waiting for you',
						summary: 'Asks which day suits Dana.',
						lastMessageAt: at(2).toISOString(),
						messages: '',
					},
					updatedAt: at(2).toISOString(),
					url: 'https://app.example.test/acme/chat/persona-1/threads/thread-1',
				},
			],
			nextPage: null,
		});
	});

	test('say a thread at work or asleep is in progress, one that stopped done unless it waits, and give a summary only while nothing was said past it', async () => {
		const {threadsConnector} = await import('./connector');
		listMemberThreads.mockResolvedValue(
			Ok({
				orgSlug: 'acme',
				threads: [
					listed({id: 'working', state: {kind: 'working'}, last: {seq: 3, pending: false, createdAt: at(3)}}),
					listed({id: 'asleep', state: {kind: 'asleep', until: at(30)}}),
					listed({id: 'done', standing: {waitingForMember: false, summary: 'Moved it to Friday.', summarySeq: 2}}),
					listed({id: 'pending', last: {seq: 2, pending: true, createdAt: at(4)}}),
					listed({id: 'unread', standing: {waitingForMember: false, summary: null, summarySeq: null}}),
					listed({id: 'empty', title: null, standing: {waitingForMember: false, summary: null, summarySeq: null}, last: null}),
				],
			}),
		);

		const {records} = (await threadsConnector.list(threads, all)).unwrap();

		expect(records.map(({id, values}) => [id, values.standing, values.summary])).toEqual([
			['working', 'In progress', ''],
			['asleep', 'In progress', 'Asks which day suits Dana.'],
			['done', 'Done', 'Moved it to Friday.'],
			['pending', 'Waiting for you', ''],
			['unread', 'Done', ''],
			['empty', 'Done', ''],
		]);
		// One nothing was said in is dated by when it was opened, and has no title.
		expect(records.at(-1)?.values).toMatchObject({title: '', lastMessageAt: at(0).toISOString()});
	});

	test('are searched and narrowed to a standing by its word, a page at a time', async () => {
		const {threadsConnector} = await import('./connector');
		listMemberThreads.mockResolvedValue(Ok({orgSlug: 'acme', threads: Array.from({length: 51}, (_, index) => listed({id: `thread-${index}`}))}));

		const first = (await threadsConnector.list(threads, {...all, search: 'pricing', filter: 'Waiting for you'})).unwrap();

		expect(listMemberThreads).toHaveBeenCalledWith('org-1', 'user-1', {search: 'pricing', standing: 'waiting', skip: 0, take: 51});
		expect(first.records).toHaveLength(50);
		expect(first.nextPage).toBe('50');

		listMemberThreads.mockResolvedValue(Ok({orgSlug: 'acme', threads: [listed()]}));
		const second = (await threadsConnector.list(threads, {...all, page: '50', filter: 'In progress'})).unwrap();
		expect(listMemberThreads).toHaveBeenLastCalledWith('org-1', 'user-1', {search: null, standing: 'in_progress', skip: 50, take: 51});
		expect(second.nextPage).toBeNull();

		expect((await threadsConnector.list(threads, {...all, filter: 'Stuck'})).unwrapErr().kind).toBe('validation_error');
		expect((await threadsConnector.list(threads, {...all, page: 'next'})).unwrapErr().kind).toBe('validation_error');
		// An organization that is gone has none.
		listMemberThreads.mockResolvedValue(Ok(null));
		expect((await threadsConnector.list(threads, all)).unwrap()).toEqual({records: [], nextPage: null});
	});

	test('open with what was said in one, as the member sees it, and say where there is none such of theirs', async () => {
		const {threadsConnector} = await import('./connector');
		const entry = (id: string, seq: number, kind: 'person' | 'assistant', text: string) => ({id, seq, kind, text, pending: false, toolCalls: null, isError: false, createdAt: at(seq)});
		const thread: ChatThreadRow = {
			id: 'thread-1',
			orgId: 'org-1',
			agentId: 'login-1',
			personaId: 'persona-1',
			userId: 'user-1',
			parentThreadId: 'chat-1',
			title: 'Pricing review with Dana',
			taskId: 'task-1',
			harness: null,
			harnessSession: null,
			createdAt: at(0),
			state: {kind: 'stopped'},
			standing: {waitingForMember: true, summary: 'Asks which day suits Dana.', summarySeq: 2},
			entries: [entry('e1', 1, 'person', 'Move the pricing review'), entry('e2', 2, 'assistant', 'Which day suits Dana?')],
			attachments: [],
		};
		getMemberThread.mockResolvedValue(Ok(thread));

		const record = (await threadsConnector.get(threads, 'thread-1')).unwrap();

		expect(getMemberThread).toHaveBeenCalledWith({orgId: 'org-1', userId: 'user-1'}, 'thread-1', ['send_to_person']);
		expect(getThreadPlace).toHaveBeenCalledWith('org-1', 'persona-1');
		expect(record).toEqual({
			id: 'thread-1',
			values: {
				title: 'Pricing review with Dana',
				agent: 'Finance',
				standing: 'Waiting for you',
				summary: 'Asks which day suits Dana.',
				lastMessageAt: at(2).toISOString(),
				messages: 'Person: Move the pricing review\n\nAgent: Which day suits Dana?',
			},
			updatedAt: at(2).toISOString(),
			url: 'https://app.example.test/acme/chat/persona-1/threads/thread-1',
		});

		getMemberThread.mockResolvedValue(Ok(null));
		expect((await threadsConnector.get(threads, 'thread-9')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
	});
});

describe('the Chat connection’s alerts', () => {
	const look = {nose: 0.5, noseOut: 0.3, eye: 25, eyeTheta: 50, eyeLat: 8, eyes: 2 as const};
	const alert: MemberAlertRow = {
		id: 'alert-1',
		orgId: 'org-1',
		userId: 'user-1',
		threadId: 'thread-2',
		title: 'Morning check',
		brief: 'See whether Dana moved the review.',
		at: at(30),
		collectionId: null,
		connectionIds: [],
		terms: [],
		lastMatchedAt: null,
		createdAt: at(0),
		persona: {id: 'persona-1', name: 'Finance', look, color: 'teal', harness: 'proxy', chatModel: 'claude', ownerUserId: null, createdById: null, createdAt: at(0)},
		threadTitle: 'Check the review every morning',
	};
	const record = {
		id: 'alert-1',
		values: {title: 'Morning check', comes: 'due 2026-10-21T10:30:00.000Z', note: 'See whether Dana moved the review.', thread: 'Check the review every morning', agent: 'Finance'},
		updatedAt: at(0).toISOString(),
		url: 'https://app.example.test/acme/chat/persona-1/threads/thread-2',
	};

	beforeEach(() => {
		listMemberAlerts.mockResolvedValue(Ok([alert]));
	});

	test('are every one the member has, each with when it comes, its note and the thread it comes to, by its page', async () => {
		const {alertsConnector} = await import('./connector');

		expect((await alertsConnector.list(alerts, all)).unwrap()).toEqual({records: [record], nextPage: null});
		expect(listMemberAlerts).toHaveBeenCalledWith('org-1', 'user-1');
		expect((await alertsConnector.get(alerts, 'alert-1')).unwrap()).toEqual(record);
		expect((await alertsConnector.get(alerts, 'alert-9')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
		expect((await alertsConnector.list(alerts, {...all, page: '2'})).unwrapErr().kind).toBe('validation_error');

		listMemberAlerts.mockResolvedValue(Ok([]));
		expect((await alertsConnector.list(alerts, all)).unwrap()).toEqual({records: [], nextPage: null});
	});

	test('are cancelled as the member’s, whichever thread one was set in', async () => {
		const {alertsConnector} = await import('./connector');
		deleteAlert.mockResolvedValue(Ok(true));

		expect((await alertsConnector.remove(alerts, 'alert-1')).isOk()).toBe(true);
		expect(deleteAlert).toHaveBeenCalledWith('alert-1', {orgId: 'org-1', userId: 'user-1'});

		deleteAlert.mockResolvedValue(Ok(false));
		expect((await alertsConnector.remove(alerts, 'alert-9')).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'record'});
	});
});
