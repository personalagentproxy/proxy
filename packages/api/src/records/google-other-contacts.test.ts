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

function otherContacts(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'otherContacts');
	if (!found) {
		throw new Error('No otherContacts collection');
	}
	return found;
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
	collection: otherContacts(),
};

// Someone Alex emailed, whom Gmail keeps with a name, and someone it keeps by the address alone.
const DANA = {
	resourceName: 'otherContacts/c222',
	metadata: {sources: [{type: 'OTHER_CONTACT', id: '222', updateTime: '2026-10-05T09:00:00Z'}]},
	names: [{displayName: 'Dana Fox', unstructuredName: 'Dana Fox'}],
	emailAddresses: [{value: 'dana@example.com'}, {value: 'dana@acme.com'}],
	phoneNumbers: [{value: '+1 555 0100'}],
};

const UNNAMED = {resourceName: 'otherContacts/c333', emailAddresses: [{value: 'billing@example.com'}]};

type Request = {method: string; url: URL; body: string};

const google = {requests: [] as Request[], answer: (_request: Request): Response | null => null};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const request = {method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : ''};
	google.requests.push(request);
	const custom = google.answer(request);
	if (custom) {
		return custom;
	}
	if (url.pathname === '/v1/otherContacts:search') {
		return Response.json(url.searchParams.get('query') === '' ? {} : {results: [{person: DANA}]});
	}
	if (url.pathname.endsWith(':copyOtherContactToMyContactsGroup')) {
		return Response.json({resourceName: 'people/c999', names: [{displayName: 'Dana Fox'}]});
	}
	return Response.json({otherContacts: [DANA, UNNAMED], nextPageToken: 'google-page-2'});
}) as typeof fetch);

beforeEach(() => {
	google.requests = [];
	google.answer = () => null;
});

describe('listing other contacts', () => {
	test('a page of Google’s list, each by its name, addresses and numbers', async () => {
		const {otherContactsConnector} = await import('./google-other-contacts');
		const page = (await otherContactsConnector.list(target, {search: null, page: null, filter: null, parent: null})).unwrap();

		const [request] = google.requests;
		expect(request?.url.pathname).toBe('/v1/otherContacts');
		expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({readMask: 'names,emailAddresses,phoneNumbers,metadata', pageSize: '50'});
		expect(page).toEqual({
			records: [
				{id: 'c222', values: {name: 'Dana Fox', emails: 'dana@example.com, dana@acme.com', phones: '+1 555 0100'}, updatedAt: '2026-10-05T09:00:00Z'},
				{id: 'c333', values: {name: '', emails: 'billing@example.com', phones: ''}, updatedAt: new Date(0).toISOString()},
			],
			nextPage: 'google-page-2',
		});
	});

	test('the next page goes on from Google’s token', async () => {
		const {otherContactsConnector} = await import('./google-other-contacts');
		await otherContactsConnector.list(target, {search: null, page: 'google-page-2', filter: null, parent: null});

		expect(google.requests[0]?.url.searchParams.get('pageToken')).toBe('google-page-2');
	});

	test('a search is Google’s, after the empty one Google asks for first', async () => {
		const {otherContactsConnector} = await import('./google-other-contacts');
		const page = (await otherContactsConnector.list(target, {search: 'dan', page: null, filter: null, parent: null})).unwrap();

		expect(google.requests.map((request) => request.url.searchParams.get('query'))).toEqual(['', 'dan']);
		expect(google.requests[1]?.url.searchParams.get('pageSize')).toBe('30');
		expect(page.records.map((record) => record.id)).toEqual(['c222']);
		expect(page.nextPage).toBeNull();
	});
});

describe('opening an other contact', () => {
	test('it is found in Google’s list, a page of 1000 at a time', async () => {
		const {otherContactsConnector} = await import('./google-other-contacts');
		google.answer = (request) =>
			request.url.searchParams.get('pageToken') === null ? Response.json({otherContacts: [UNNAMED], nextPageToken: 'google-page-2'}) : Response.json({otherContacts: [DANA]});
		const record = (await otherContactsConnector.get(target, 'c222')).unwrap();

		expect(google.requests.map((request) => [request.url.searchParams.get('pageSize'), request.url.searchParams.get('pageToken')])).toEqual([
			['1000', null],
			['1000', 'google-page-2'],
		]);
		expect(record.values.name).toBe('Dana Fox');
	});

	test('one not in the list, or an id that isn’t Google’s, is not found', async () => {
		const {otherContactsConnector} = await import('./google-other-contacts');
		google.answer = () => Response.json({otherContacts: [UNNAMED]});
		const missing = await otherContactsConnector.get(target, 'c404');
		const wrong = await otherContactsConnector.get(target, '../people/c222');

		expect(missing.isErr() && missing.error.kind).toBe('not_found');
		expect(wrong.isErr() && wrong.error.kind).toBe('not_found');
		expect(google.requests).toHaveLength(1);
	});
});

describe('saving an other contact', () => {
	test('copies its names, addresses and numbers into Google Contacts', async () => {
		const {otherContactsConnector} = await import('./google-other-contacts');
		const result = (await otherContactsConnector.commands?.save?.(target, 'c222'))?.unwrap();

		const [request] = google.requests;
		expect(request?.method).toBe('POST');
		expect(request?.url.pathname).toBe('/v1/otherContacts/c222:copyOtherContactToMyContactsGroup');
		expect(JSON.parse(request?.body ?? '').copyMask).toBe('names,emailAddresses,phoneNumbers');
		expect(result).toBeNull();
	});
});
