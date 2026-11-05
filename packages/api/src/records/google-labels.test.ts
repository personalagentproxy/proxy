import {beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

mock.module('@proxy/db/connection', () => ({updateConnectionCredential: mock(), getConnectionCredential: mock(async () => Ok(null))}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

mock.module('../utils/env', () => ({env: {NODE_ENV: 'production', APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-1', GOOGLE_CLIENT_SECRET: 'secret-1'}}));

mock.module('../utils/secret-crypto', () => ({
	encryptSecret: (plaintext: string): Result<string, ApiError> => Ok(`enc:${plaintext}`),
	decryptSecret: (stored: string): Result<string, ApiError> => Ok(stored.replace(/^enc:/, '')),
}));

function collection(id: string): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, id);
	if (!found) {
		throw new Error(`No ${id} collection`);
	}
	return found;
}

const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'alex@example.com'};

const connection = {
	id: 'google-1',
	integrationId: 'google',
	orgId: 'org-1',
	ownerUserId: 'user-1',
	connectedById: 'user-1',
	account: 'alex@example.com',
	createdAt: new Date(),
	tools: null,
	name: null,
	defaults: [],
	credential: `enc:${JSON.stringify(CREDENTIAL)}`,
};

const target = {connection, collection: collection('labels')};

const query = (changes: object = {}) => ({search: null, page: null, filter: null, parent: null, ...changes});

type Label = {id: string; name: string; type: 'system' | 'user'; messagesTotal?: number; messagesUnread?: number};

// An account with Gmail's own labels, two it made, and an email in the inbox with one of them on it.
function account() {
	return {
		labels: [
			{id: 'INBOX', name: 'INBOX', type: 'system'},
			{id: 'STARRED', name: 'STARRED', type: 'system'},
			{id: 'UNREAD', name: 'UNREAD', type: 'system'},
			{id: 'Label_2', name: 'Receipts', type: 'user', messagesTotal: 40, messagesUnread: 2},
			{id: 'Label_1', name: 'Clients/Acme', type: 'user', messagesTotal: 12, messagesUnread: 0},
		] as Label[],
		emails: {m1: ['INBOX', 'UNREAD', 'Label_1']} as Record<string, string[]>,
	};
}

type Call = {method: string; path: string; body: Record<string, unknown> | null};

const gmail = {calls: [] as Call[], ...account()};

function notFound(): Response {
	return Response.json({error: {code: 404, message: 'Requested entity was not found.', errors: [{reason: 'notFound'}]}}, {status: 404});
}

function answer(call: Call): Response {
	if (call.path === '/labels' && call.method === 'GET') {
		return Response.json({labels: gmail.labels.map(({id, name, type}) => ({id, name, type}))});
	}
	if (call.path === '/labels' && call.method === 'POST') {
		const made: Label = {id: `Label_${gmail.labels.length + 1}`, name: String(call.body?.name), type: 'user'};
		gmail.labels.push(made);
		return Response.json(made);
	}
	const labelId = /^\/labels\/([^/]+)$/.exec(call.path)?.[1];
	if (labelId) {
		const found = gmail.labels.find((label) => label.id === labelId);
		return found ? Response.json(found) : notFound();
	}
	const messageId = /^\/messages\/([^/]+)\/modify$/.exec(call.path)?.[1];
	const labelIds = messageId ? gmail.emails[messageId] : undefined;
	if (!messageId || !labelIds) {
		return notFound();
	}
	const {addLabelIds = [], removeLabelIds = []} = call.body as {addLabelIds?: string[]; removeLabelIds?: string[]};
	gmail.emails[messageId] = [...labelIds.filter((label) => !removeLabelIds.includes(label)), ...addLabelIds];
	return Response.json({id: messageId, labelIds: gmail.emails[messageId]});
}

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
	const call = {method: init?.method ?? 'GET', path: url.pathname.replace('/gmail/v1/users/me', ''), body};
	gmail.calls.push(call);
	return answer(call);
}) as typeof fetch);

beforeEach(() => {
	gmail.calls = [];
	Object.assign(gmail, account());
});

async function connector() {
	const {gmailLabelsConnector} = await import('./google-labels');
	return gmailLabelsConnector;
}

describe('list and get', () => {
	test('only the labels the account made are listed, by name, with their page in Gmail', async () => {
		const page = (await (await connector()).list(target, query())).unwrap();

		expect(page.records.map((record) => [record.id, record.values.label])).toEqual([
			['Label_1', 'Clients/Acme'],
			['Label_2', 'Receipts'],
		]);
		expect(page.records[0]?.url).toBe('https://mail.google.com/mail/?authuser=alex%40example.com#label/Clients%2FAcme');
		expect(page.nextPage).toBeNull();
	});

	test('a search narrows the names to those holding its words, and a next page is refused', async () => {
		const c = await connector();

		expect((await c.list(target, query({search: 'acme'}))).unwrap().records.map((record) => record.id)).toEqual(['Label_1']);
		expect((await c.list(target, query({page: 'page-2'}))).unwrapErr().kind).toBe('validation_error');
	});

	test('a label opens with how many emails it is on, and Gmail’s own are never opened', async () => {
		const c = await connector();

		expect((await c.get(target, 'Label_2')).unwrap().values).toEqual({label: 'Receipts', messages: '40', unread: '2'});
		expect((await c.get(target, 'INBOX')).unwrapErr().kind).toBe('not_found');
		expect((await c.get(target, 'Label_9')).unwrapErr()).toMatchObject({kind: 'not_found', id: 'Label_9'});
		expect(gmail.calls.map((call) => call.path)).toEqual(['/labels/Label_2', '/labels/Label_9']);
	});
});

describe('add and remove', () => {
	test('adding puts the label of the name on the email, its case as Gmail has it', async () => {
		const record = (await (await connector()).newCommands.add(target, {email: 'm1', label: 'receipts'})).unwrap();

		expect(gmail.calls.find((call) => call.path === '/messages/m1/modify')?.body).toEqual({addLabelIds: ['Label_2'], removeLabelIds: []});
		expect(record).toMatchObject({id: 'Label_2', values: {label: 'Receipts', email: 'm1', made: 'No'}});
		expect(gmail.calls.some((call) => call.method === 'POST' && call.path === '/labels')).toBe(false);
	});

	test('adding a label the account has none of makes it first', async () => {
		const record = (await (await connector()).newCommands.add(target, {email: 'm1', label: ' Follow up '})).unwrap();

		expect(gmail.calls.find((call) => call.method === 'POST' && call.path === '/labels')?.body).toEqual({name: 'Follow up', labelListVisibility: 'labelShow', messageListVisibility: 'show'});
		expect(record).toMatchObject({id: 'Label_6', values: {label: 'Follow up', made: 'Yes'}});
		expect(gmail.emails.m1).toContain('Label_6');
	});

	test('removing takes the label off and leaves the label; one the account hasn’t is refused', async () => {
		const c = await connector();

		expect((await c.newCommands.remove(target, {email: 'm1', label: 'Clients/Acme'})).unwrap()).toMatchObject({id: 'Label_1', values: {email: 'm1'}});
		expect(gmail.emails.m1).toEqual(['INBOX', 'UNREAD']);
		expect(gmail.labels.some((label) => label.id === 'Label_1')).toBe(true);
		expect((await c.newCommands.remove(target, {email: 'm1', label: 'Nope'})).unwrapErr()).toMatchObject({kind: 'validation_error', message: 'The account has no label named Nope'});
	});

	test('Gmail’s own labels are never put on or taken off, so marking, starring and archiving keep their own actions', async () => {
		const c = await connector();

		for (const label of ['Starred', 'UNREAD', 'inbox']) {
			expect((await c.newCommands.add(target, {email: 'm1', label})).unwrapErr().kind).toBe('validation_error');
			expect((await c.newCommands.remove(target, {email: 'm1', label})).unwrapErr().kind).toBe('validation_error');
		}
		expect(gmail.calls.some((call) => call.path.includes('/modify') || call.method === 'POST')).toBe(false);
	});

	test('a draft isn’t labelled, an email Gmail doesn’t have is not found, and both email and label are needed', async () => {
		const c = await connector();

		expect((await c.newCommands.add(target, {email: 'draft-r1', label: 'Receipts'})).unwrapErr().kind).toBe('validation_error');
		expect((await c.newCommands.add(target, {email: 'gone', label: 'Receipts'})).unwrapErr()).toMatchObject({kind: 'not_found', id: 'gone'});
		expect((await c.newCommands.add(target, {email: '../labels', label: 'Receipts'})).unwrapErr().kind).toBe('not_found');
		expect((await c.newCommands.add(target, {label: 'Receipts'})).unwrapErr().kind).toBe('validation_error');
		expect((await c.newCommands.add(target, {email: 'm1', label: ' '})).unwrapErr().kind).toBe('validation_error');
	});
});

describe('an email opened', () => {
	test('shows the names of the labels the account made on it, and asks for them only where it has any', async () => {
		const {labelNames} = await import('./google-labels');

		expect((await labelNames('access-1', ['INBOX', 'Label_2', 'Label_1'])).unwrap()).toBe('Receipts, Clients/Acme');
		expect((await labelNames('access-1', ['INBOX', 'UNREAD'])).unwrap()).toBe('');
		expect(gmail.calls).toHaveLength(1);
	});

	test('the emails collection has the field', () => {
		expect(collection('emails').fields.find((field) => field.key === 'labels')).toMatchObject({system: true});
	});
});
