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

function availability(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'availability');
	if (!found) {
		throw new Error('No availability collection');
	}
	return found;
}

// What a refusal says, or its kind where it says nothing of its own.
function messageOf<T>(result: Result<T, ApiError> | undefined): string | null {
	if (!result || result.isOk()) {
		return null;
	}
	return ('message' in result.error && result.error.message) || result.error.kind;
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
	collection: availability(),
};

const PRIMARY = {id: 'alex@example.com', summary: 'alex@example.com', primary: true, timeZone: 'Europe/Berlin'};

// Alex has a standup and lunch; Dana has a long meeting overlapping lunch; Sam's calendar can't be seen.
const FREE_BUSY = {
	calendars: {
		primary: {
			busy: [
				{start: '2026-10-15T07:00:00Z', end: '2026-10-15T07:30:00Z'},
				{start: '2026-10-15T10:00:00Z', end: '2026-10-15T11:00:00Z'},
			],
		},
		'dana@example.com': {busy: [{start: '2026-10-15T10:30:00Z', end: '2026-10-15T12:00:00Z'}]},
		'sam@example.com': {errors: [{domain: 'global', reason: 'notFound'}], busy: []},
	},
};

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
	if (url.pathname === '/calendar/v3/freeBusy') {
		return Response.json(FREE_BUSY);
	}
	return Response.json(PRIMARY);
}) as typeof fetch);

beforeEach(() => {
	google.requests = [];
	google.answer = () => null;
});

function freeBusyBody(): {timeMin: string; timeMax: string; items: Array<{id: string}>} {
	const request = google.requests.find((one) => one.url.pathname === '/calendar/v3/freeBusy');
	return JSON.parse(request?.body ?? '{}');
}

describe('checking availability', () => {
	test('asks Google when the account and the people named are busy, on the primary calendar’s clock', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.newCommands?.check?.(target, {people: 'Dana Fox <Dana@example.com>, sam@example.com', from: '2026-10-15T08:00', to: '2026-10-15T18:00'}))?.unwrap();

		expect(google.requests[0]?.url.pathname).toBe('/calendar/v3/users/me/calendarList/primary');
		expect(freeBusyBody()).toEqual({
			timeMin: '2026-10-15T06:00:00.000Z',
			timeMax: '2026-10-15T16:00:00.000Z',
			items: [{id: 'primary'}, {id: 'dana@example.com'}, {id: 'sam@example.com'}],
		});
		expect(record?.values).toEqual({
			people: 'dana@example.com, sam@example.com',
			from: '2026-10-15 08:00',
			to: '2026-10-15 18:00',
			timeZone: 'Europe/Berlin',
			busy: ['You (alex@example.com): 2026-10-15 09:00–09:30, 2026-10-15 12:00–13:00', 'dana@example.com: 2026-10-15 12:30–14:00', 'sam@example.com: can’t see this calendar'].join('\n'),
			free: ['2026-10-15 08:00–09:00', '2026-10-15 09:30–12:00', '2026-10-15 14:00–18:00', 'Not counting sam@example.com, whose calendar can’t be seen'].join('\n'),
		});
	});

	test('a day alone is the whole day, and times with an offset are taken as they are', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.newCommands?.check?.(target, {people: '', from: '2026-10-15', to: '2026-10-16'});
		const days = freeBusyBody();
		google.requests = [];
		await googleConnector.newCommands?.check?.(target, {people: '', from: '2026-10-15T09:00:00Z', to: '2026-10-15T17:00:00+01:00'});

		expect([days.timeMin, days.timeMax]).toEqual(['2026-10-14T22:00:00.000Z', '2026-10-16T22:00:00.000Z']);
		expect([freeBusyBody().timeMin, freeBusyBody().timeMax]).toEqual(['2026-10-15T09:00:00.000Z', '2026-10-15T16:00:00.000Z']);
	});

	test('left out, it checks the account alone, from now for a week', async () => {
		const {googleConnector} = await import('./google-connector');
		const before = Date.now();
		await googleConnector.newCommands?.check?.(target, {people: '', from: '', to: ''});
		const body = freeBusyBody();

		expect(body.items).toEqual([{id: 'primary'}]);
		expect(Date.parse(body.timeMin)).toBeGreaterThanOrEqual(before - 1000);
		expect(Date.parse(body.timeMax) - Date.parse(body.timeMin)).toBe(7 * 24 * 3_600_000);
	});

	test('busy times running past the window are cut to it, and someone with nothing on is free', async () => {
		const {googleConnector} = await import('./google-connector');
		google.answer = (request) =>
			request.url.pathname === '/calendar/v3/freeBusy'
				? Response.json({calendars: {primary: {busy: [{start: '2026-10-14T20:00:00Z', end: '2026-10-15T07:00:00Z'}]}, 'dana@example.com': {busy: []}}})
				: null;
		const record = (await googleConnector.newCommands?.check?.(target, {people: 'dana@example.com', from: '2026-10-15T08:00', to: '2026-10-15T12:00'}))?.unwrap();

		expect(record?.values.busy).toBe('You (alex@example.com): 2026-10-15 08:00–09:00\ndana@example.com: free');
		expect(record?.values.free).toBe('2026-10-15 09:00–12:00');
	});

	test('the account named among the people is checked once', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.newCommands?.check?.(target, {people: 'ALEX@example.com, dana@example.com', from: '2026-10-15', to: ''});

		expect(freeBusyBody().items).toEqual([{id: 'primary'}, {id: 'dana@example.com'}]);
	});

	test('people that aren’t addresses, times that aren’t times, and a to before from never reach free/busy', async () => {
		const {googleConnector} = await import('./google-connector');
		const refusals = await Promise.all([
			googleConnector.newCommands?.check?.(target, {people: 'Dana', from: '', to: ''}),
			googleConnector.newCommands?.check?.(target, {people: '', from: 'tomorrow', to: ''}),
			googleConnector.newCommands?.check?.(target, {people: '', from: '2026-10-16', to: '2026-10-15T12:00'}),
			googleConnector.newCommands?.check?.(target, {people: Array.from({length: 50}, (_, index) => `p${index}@example.com`).join(','), from: '', to: ''}),
		]);

		expect(refusals.map(messageOf)).toEqual([
			'Write each person as their email address, not “Dana”',
			'Write from as a time, 2026-10-15T09:00, on your calendar’s clock or with an offset such as +02:00, or as a day, 2026-10-15, not “tomorrow”',
			'Write a to that is after from',
			'Google checks 49 people at most at once, beside you',
		]);
		expect(google.requests.filter((request) => request.url.pathname === '/calendar/v3/freeBusy')).toEqual([]);
	});

	test('availability is never listed or opened', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.list(target, {search: null, page: null, filter: null, parent: null});

		expect(result.isErr() && result.error.kind).toBe('validation_error');
	});
});
