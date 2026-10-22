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

function contacts(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'contacts');
	if (!found) {
		throw new Error('No contacts collection');
	}
	return found;
}

function messageOf<T>(result: Result<T, ApiError> | undefined): string | null {
	if (!result || result.isOk()) {
		return null;
	}
	return 'message' in result.error ? result.error.message : result.error.kind;
}

const CREDENTIAL = {accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: [], email: 'alex@example.com'};

const target = {
	connection: {
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
	},
	collection: contacts(),
};

const CONTACT = {type: 'CONTACT'};
const PROFILE = {type: 'PROFILE'};

// Sam's contact, with what Sam's own Google profile shows beside it.
const SAM = {
	resourceName: 'people/c111',
	etag: '%EgUBAi43PRoEAQIFByIM',
	metadata: {
		sources: [
			{type: 'CONTACT', id: '111', etag: '#abc', updateTime: '2026-10-01T08:00:00Z'},
			{type: 'PROFILE', id: '999', etag: '#xyz'},
		],
	},
	names: [{displayName: 'Sam Lee', unstructuredName: 'Sam Lee', metadata: {source: CONTACT}}],
	emailAddresses: [
		{value: 'sam@acme.com', type: 'work', metadata: {source: CONTACT}},
		{value: 'sam@example.com', metadata: {source: PROFILE}},
	],
	phoneNumbers: [{value: '+44 20 7946 0000', type: 'mobile', metadata: {source: CONTACT}}],
	organizations: [{name: 'Acme', title: 'Head of Sales', metadata: {source: CONTACT}}],
	addresses: [{formattedValue: '1 Main St\nLondon\nUK', type: 'work', metadata: {source: CONTACT}}],
	birthdays: [{date: {month: 4, day: 12}, metadata: {source: CONTACT}}],
	biographies: [{value: 'Met at the Q3 offsite', metadata: {source: CONTACT}}],
};

const KIM = {resourceName: 'people/c222', names: [{displayName: 'Kim Park'}], emailAddresses: [{value: 'kim@example.com'}]};

type Request = {method: string; url: URL; body: string};

const google = {requests: [] as Request[]};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const request = {method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : ''};
	google.requests.push(request);
	if (url.pathname === '/v1/people/me/connections') {
		return Response.json({connections: [SAM, KIM], nextPageToken: 'page-2'});
	}
	if (url.pathname === '/v1/people:searchContacts') {
		return Response.json(url.searchParams.get('query') === '' ? {} : {results: [{person: SAM}]});
	}
	if (url.pathname === '/v1/people:createContact') {
		return Response.json({resourceName: 'people/c333', ...JSON.parse(request.body)});
	}
	if (url.pathname === '/v1/people/c111:updateContact') {
		return Response.json({...SAM, ...JSON.parse(request.body)});
	}
	if (url.pathname === '/v1/people/c111') {
		return Response.json(SAM);
	}
	return Response.json({error: {code: 404, message: 'Requested entity was not found.'}}, {status: 404});
}) as typeof fetch);

beforeEach(() => {
	google.requests = [];
});

const LIST = {search: null, page: null, filter: null, parent: null};

describe('listing', () => {
	test('lists contacts, the most recently changed first, with Google’s page token', async () => {
		const {googleConnector} = await import('./google-connector');
		const page = (await googleConnector.list(target, {...LIST, page: 'page-1'})).unwrap();

		const [request] = google.requests;
		expect(request?.url.searchParams.get('sortOrder')).toBe('LAST_MODIFIED_DESCENDING');
		expect(request?.url.searchParams.get('pageToken')).toBe('page-1');
		expect(page.records.map((record) => [record.id, record.values.name, record.values.emails])).toEqual([
			['c111', 'Sam Lee', 'sam@acme.com, sam@example.com'],
			['c222', 'Kim Park', 'kim@example.com'],
		]);
		expect(page.nextPage).toBe('page-2');
	});

	test('a search warms Google’s search up first, as Google asks, and has no next page', async () => {
		const {googleConnector} = await import('./google-connector');
		const page = (await googleConnector.list(target, {...LIST, search: 'sam'})).unwrap();

		expect(google.requests.map((request) => request.url.searchParams.get('query'))).toEqual(['', 'sam']);
		expect(page.records.map((record) => record.id)).toEqual(['c111']);
		expect(page.nextPage).toBeNull();

		const paged = await googleConnector.list(target, {...LIST, search: 'sam', page: 'page-2'});
		expect(paged.isErr() && paged.error.kind).toBe('validation_error');
	});
});

test('a contact opens with every field, an address written over lines on one, a birthday without its year', async () => {
	const {googleConnector} = await import('./google-connector');
	const record = (await googleConnector.get(target, 'c111')).unwrap();

	expect(record.values).toEqual({
		name: 'Sam Lee',
		emails: 'sam@acme.com, sam@example.com',
		phones: '+44 20 7946 0000',
		company: 'Acme',
		jobTitle: 'Head of Sales',
		addresses: '1 Main St, London, UK',
		birthday: '04-12',
		notes: 'Met at the Q3 offsite',
	});
	expect(record.updatedAt).toBe('2026-10-01T08:00:00Z');
	expect(record.url).toBe('https://contacts.google.com/person/c111');
	expect(messageOf(await googleConnector.get(target, 'people/c111'))).toBe('not_found');
	expect(messageOf(await googleConnector.get(target, 'c404'))).toBe('not_found');
});

const BLANK = {name: '', emails: '', phones: '', company: '', jobTitle: '', addresses: '', birthday: '', notes: ''};

describe('creating', () => {
	test('a contact is made from what is written, each email, number and address its own', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (
			await googleConnector.create(
				target,
				{...BLANK, name: 'Kim Park', emails: 'kim@example.com, kim@acme.com', phones: '+1 555 0100', company: 'Acme', birthday: '1990-04-12', addresses: '1 Main St, London\n2 High St, Leeds'},
				null,
			)
		).unwrap();

		const create = google.requests.find((request) => request.method === 'POST');
		expect(JSON.parse(create?.body ?? '')).toEqual({
			names: [{unstructuredName: 'Kim Park'}],
			emailAddresses: [{value: 'kim@example.com'}, {value: 'kim@acme.com'}],
			phoneNumbers: [{value: '+1 555 0100'}],
			organizations: [{name: 'Acme', title: ''}],
			addresses: [{formattedValue: '1 Main St, London'}, {formattedValue: '2 High St, Leeds'}],
			birthdays: [{date: {year: 1990, month: 4, day: 12}}],
			biographies: [],
		});
		expect(record.id).toBe('c333');
	});

	test('an empty contact, an email that is no address and a birthday that is no day are refused before Google is asked', async () => {
		const {googleConnector} = await import('./google-connector');

		expect(messageOf(await googleConnector.create(target, BLANK, null))).toBe('Write at least a name, an email or a phone number for the contact');
		expect(messageOf(await googleConnector.create(target, {...BLANK, name: 'Kim', emails: 'kim at acme'}, null))).toBe('Write each email as an address, not “kim at acme”');
		expect(messageOf(await googleConnector.create(target, {...BLANK, name: 'Kim', birthday: '02-30'}, null))).toBe('Write the birthday as 1990-04-12, or 04-12 without the year, not “02-30”');
		expect(google.requests).toEqual([]);
	});
});

describe('editing', () => {
	test('only the fields written differently are sent, with the etag, keeping the type of an email still there', async () => {
		const {googleConnector} = await import('./google-connector');
		const before = (await googleConnector.get(target, 'c111')).unwrap();
		google.requests = [];
		await googleConnector.update(target, 'c111', {...before.values, emails: 'sam@acme.com, sam.lee@gmail.com', jobTitle: 'VP Sales'}, before);

		const update = google.requests.find((request) => request.method === 'PATCH');
		expect(update?.url.searchParams.get('updatePersonFields')).toBe('emailAddresses,organizations');
		expect(JSON.parse(update?.body ?? '')).toEqual({
			emailAddresses: [{value: 'sam@acme.com', type: 'work'}, {value: 'sam.lee@gmail.com'}],
			organizations: [{name: 'Acme', title: 'VP Sales'}],
			etag: '%EgUBAi43PRoEAQIFByIM',
			metadata: {sources: [{type: 'CONTACT', id: '111', etag: '#abc', updateTime: '2026-10-01T08:00:00Z'}]},
		});
	});

	test('nothing written differently sends nothing', async () => {
		const {googleConnector} = await import('./google-connector');
		const before = (await googleConnector.get(target, 'c111')).unwrap();
		google.requests = [];
		await googleConnector.update(target, 'c111', {...before.values}, before);

		expect(google.requests.filter((request) => request.method === 'PATCH')).toEqual([]);
	});
});

test('contacts are never deleted', async () => {
	const {googleConnector} = await import('./google-connector');

	expect(messageOf(await googleConnector.remove(target, 'c111'))).toBe('Contacts in Google Contacts are never deleted here');
});
