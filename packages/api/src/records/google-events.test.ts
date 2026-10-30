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

function events(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'events');
	if (!found) {
		throw new Error('No events collection');
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
	collection: events(),
};

const PRIMARY = {id: 'alex@example.com', summary: 'alex@example.com', primary: true, timeZone: 'Europe/Berlin'};
const TEAM = {id: 'team@group.calendar.google.com', summary: 'Team', summaryOverride: 'Acme team', description: 'Offsites and launches', timeZone: 'Europe/Berlin'};

// Sam invited Alex; Room 3 is booked.
const PLANNING = {
	id: 'ev2',
	status: 'confirmed',
	htmlLink: 'https://www.google.com/calendar/event?eid=ev2',
	summary: 'Q4 planning',
	location: 'Room 3',
	start: {dateTime: '2026-10-15T14:00:00+02:00'},
	end: {dateTime: '2026-10-15T15:30:00+02:00'},
	organizer: {email: 'sam@example.com', displayName: 'Sam Lee'},
	attendees: [
		{email: 'sam@example.com', displayName: 'Sam Lee', organizer: true, responseStatus: 'accepted'},
		{email: 'alex@example.com', self: true, responseStatus: 'needsAction'},
		{email: 'lee@example.com', responseStatus: 'tentative'},
		{email: 'room-3@resource.calendar.google.com', resource: true, responseStatus: 'accepted'},
	],
	recurringEventId: 'ev2base',
	hangoutLink: 'https://meet.google.com/abc-defg-hij',
	updated: '2026-10-01T08:00:00.000Z',
};

const OFFSITE = {
	id: 'ev3',
	status: 'confirmed',
	summary: 'Offsite',
	start: {date: '2026-10-20'},
	end: {date: '2026-10-22'},
	organizer: {email: 'alex@example.com', self: true},
	updated: '2026-10-02T08:00:00.000Z',
};

const FOCUS = {
	id: 'ev1',
	status: 'confirmed',
	summary: 'Focus',
	start: {dateTime: '2026-10-15T09:00:00+02:00'},
	end: {dateTime: '2026-10-15T11:00:00+02:00'},
	organizer: {email: 'alex@example.com', self: true},
	updated: '2026-10-01T07:00:00.000Z',
};

type Request = {method: string; url: URL; body: string};

const google = {requests: [] as Request[], answer: (_request: Request): Response | null => null};

const EVENTS: Record<string, object> = {ev1: FOCUS, ev2: PLANNING, ev3: OFFSITE};

spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
	const request = {method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : ''};
	google.requests.push(request);
	const custom = google.answer(request);
	if (custom) {
		return custom;
	}
	const path = decodeURIComponent(url.pathname);
	if (path === '/calendar/v3/users/me/calendarList') {
		return Response.json({items: [TEAM, PRIMARY]});
	}
	if (path.startsWith('/calendar/v3/users/me/calendarList/')) {
		const id = path.split('/').at(-1);
		return Response.json(id === TEAM.id ? TEAM : PRIMARY);
	}
	if (path.endsWith('/events') && request.method === 'GET') {
		return Response.json({items: [FOCUS, PLANNING], nextPageToken: 'google-page-2'});
	}
	if (path.endsWith('/events') && request.method === 'POST') {
		return Response.json({id: 'ev9', status: 'confirmed', organizer: {self: true}, ...JSON.parse(request.body)});
	}
	const id = path.split('/').at(-1) ?? '';
	const event = EVENTS[id];
	if (!event) {
		return Response.json({error: {code: 404, message: 'Not Found'}}, {status: 404});
	}
	if (request.method === 'PATCH') {
		return Response.json({...event, ...JSON.parse(request.body)});
	}
	return Response.json(event);
}) as typeof fetch);

beforeEach(() => {
	google.requests = [];
	google.answer = () => null;
});

const LIST = {search: null, page: null, filter: null, parent: null};

describe('listing', () => {
	test('the top is the calendars, the primary first, each holding its events', async () => {
		const {googleConnector} = await import('./google-connector');
		const page = (await googleConnector.list(target, LIST)).unwrap();

		expect(page.records.map((record) => [record.id, record.values.title, record.hasChildren])).toEqual([
			['alex@example.com', 'alex@example.com', true],
			['team@group.calendar.google.com', 'Acme team', true],
		]);
		expect(page.nextPage).toBeNull();

		const paged = await googleConnector.list(target, {...LIST, page: 'next'});
		expect(paged.isErr() && paged.error.kind).toBe('validation_error');
	});

	test("inside a calendar are its events from now on, soonest first, every time a repeating one comes round, and the calendar's name in the trail", async () => {
		const {googleConnector} = await import('./google-connector');
		const before = Date.now();
		const page = (await googleConnector.list(target, {...LIST, parent: TEAM.id})).unwrap();

		const list = google.requests.find((request) => request.url.pathname.endsWith('/events'));
		expect(decodeURIComponent(list?.url.pathname ?? '')).toBe('/calendar/v3/calendars/team@group.calendar.google.com/events');
		expect(list?.url.searchParams.get('singleEvents')).toBe('true');
		expect(list?.url.searchParams.get('orderBy')).toBe('startTime');
		expect(Date.parse(list?.url.searchParams.get('timeMin') ?? '')).toBeGreaterThanOrEqual(before - 1000);
		expect(page.records.map((record) => record.id)).toEqual(['team@group.calendar.google.com:ev1', 'team@group.calendar.google.com:ev2']);
		expect(page.trail).toEqual([{id: TEAM.id, title: 'Acme team'}]);
		expect(page.nextPage).not.toBeNull();
	});

	test('the next page goes on from where the first began, with Google’s token', async () => {
		const {googleConnector} = await import('./google-connector');
		const first = (await googleConnector.list(target, {...LIST, parent: TEAM.id})).unwrap();
		const firstFrom = google.requests.find((request) => request.url.pathname.endsWith('/events'))?.url.searchParams.get('timeMin');
		google.requests = [];
		await googleConnector.list(target, {...LIST, parent: TEAM.id, page: first.nextPage});

		const second = google.requests.find((request) => request.url.pathname.endsWith('/events'));
		expect(second?.url.searchParams.get('pageToken')).toBe('google-page-2');
		expect(second?.url.searchParams.get('timeMin')).toBe(firstFrom ?? '');
	});

	test("a search that begins with a day lists from that day's start on the calendar's clock, its words searched for", async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.list(target, {...LIST, search: '2026-10-15 planning'});

		const list = google.requests.find((request) => request.url.pathname.endsWith('/events'));
		expect(decodeURIComponent(list?.url.pathname ?? '')).toBe('/calendar/v3/calendars/alex@example.com/events');
		expect(list?.url.searchParams.get('timeMin')).toBe('2026-10-14T22:00:00.000Z');
		expect(list?.url.searchParams.get('q')).toBe('planning');
	});

	test('a search of words alone is from now on, in the primary calendar at the top', async () => {
		const {googleConnector} = await import('./google-connector');
		const page = (await googleConnector.list(target, {...LIST, search: 'planning'})).unwrap();

		const list = google.requests.find((request) => request.url.pathname.endsWith('/events'));
		expect(list?.url.searchParams.get('q')).toBe('planning');
		expect(page.trail).toBeUndefined();
	});

	test('events hold nothing to list', async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.list(target, {...LIST, parent: 'alex@example.com:ev1'});

		expect(messageOf(result)).toBe('Events hold nothing: give a calendar’s id as parent');
	});
});

describe('opening', () => {
	test("an invitation reads with its guests by address, their answers, the account's own, the organizer, and where it repeats", async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.get(target, 'alex@example.com:ev2')).unwrap();

		expect(record.values).toEqual({
			title: 'Q4 planning',
			kind: 'Event',
			start: '2026-10-15T14:00:00+02:00',
			end: '2026-10-15T15:30:00+02:00',
			location: 'Room 3',
			guests: 'sam@example.com, lee@example.com',
			description: '',
			answers: 'Sam Lee <sam@example.com>: Accepted\nlee@example.com: Maybe',
			response: 'Needs action',
			organizer: 'Sam Lee <sam@example.com>',
			repeats: 'Yes',
			meeting: 'https://meet.google.com/abc-defg-hij',
		});
		expect(record.url).toBe('https://www.google.com/calendar/event?eid=ev2');
	});

	test("an all-day event's end reads as its last day, and the account's own event has no answer", async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.get(target, 'alex@example.com:ev3')).unwrap();

		expect(record.values).toMatchObject({start: '2026-10-20', end: '2026-10-21', response: '', organizer: ''});
	});

	test('a calendar opens as one, and an event that is gone or an id that is no event is not found', async () => {
		const {googleConnector} = await import('./google-connector');

		expect((await googleConnector.get(target, TEAM.id)).unwrap().values).toEqual({title: 'Acme team', kind: 'Calendar', description: 'Offsites and launches'});
		expect(messageOf(await googleConnector.get(target, 'alex@example.com:gone'))).toBe('not_found');
		expect(messageOf(await googleConnector.get(target, 'alex@example.com:ev/1'))).toBe('not_found');
	});
});

const BLANK = {title: '', start: '', end: '', location: '', guests: '', description: ''};

describe('creating', () => {
	test('an event without guests goes in the calendar given, on its clock, an hour long, telling no one', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.create(target, {...BLANK, title: 'Focus', start: '2026-10-15 09:30'}, TEAM.id)).unwrap();

		const insert = google.requests.find((request) => request.method === 'POST');
		expect(decodeURIComponent(insert?.url.pathname ?? '')).toBe('/calendar/v3/calendars/team@group.calendar.google.com/events');
		expect(insert?.url.searchParams.get('sendUpdates')).toBe('none');
		expect(JSON.parse(insert?.body ?? '')).toEqual({
			summary: 'Focus',
			start: {dateTime: '2026-10-15T09:30:00', timeZone: 'Europe/Berlin'},
			end: {dateTime: '2026-10-15T10:30:00', timeZone: 'Europe/Berlin'},
		});
		expect(record.id).toBe('team@group.calendar.google.com:ev9');
	});

	test('one made at the top goes in the primary calendar, by its own id', async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.create(target, {...BLANK, title: 'Focus', start: '2026-10-15T09:30:00Z'}, null)).unwrap();

		const insert = google.requests.find((request) => request.method === 'POST');
		expect(JSON.parse(insert?.body ?? '').start).toEqual({dateTime: '2026-10-15T09:30:00Z'});
		expect(JSON.parse(insert?.body ?? '').end).toEqual({dateTime: '2026-10-15T10:30:00Z'});
		expect(record.id).toBe('alex@example.com:ev9');
	});

	test("an all-day event's end is written as its last day, which Google keeps as the day after", async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.create(target, {...BLANK, title: 'Offsite', start: '2026-10-20', end: '2026-10-21'}, null);
		await googleConnector.create(target, {...BLANK, title: 'Holiday', start: '2026-10-23'}, null);

		const [offsite, holiday] = google.requests.filter((request) => request.method === 'POST').map((request) => JSON.parse(request.body));
		expect([offsite.start, offsite.end]).toEqual([{date: '2026-10-20'}, {date: '2026-10-22'}]);
		expect([holiday.start, holiday.end]).toEqual([{date: '2026-10-23'}, {date: '2026-10-24'}]);
	});

	test('guests are invited, and Google emails them', async () => {
		const {googleConnector} = await import('./google-connector');
		await googleConnector.create(target, {...BLANK, title: 'Q4 planning', start: '2026-10-15T14:00', guests: 'Sam@example.com, Lee <lee@example.com>'}, null);

		const insert = google.requests.find((request) => request.method === 'POST');
		expect(insert?.url.searchParams.get('sendUpdates')).toBe('all');
		expect(JSON.parse(insert?.body ?? '').attendees).toEqual([{email: 'sam@example.com'}, {email: 'lee@example.com'}]);
	});

	test('a time Google would not take, a missing start or a day with a time is refused before Google is asked', async () => {
		const {googleConnector} = await import('./google-connector');

		expect(messageOf(await googleConnector.create(target, {...BLANK, start: 'tomorrow at 3'}, null))).toContain('Write start as a time, 2026-10-15T14:00');
		expect(messageOf(await googleConnector.create(target, {...BLANK, start: '2026-02-30'}, null))).toContain('Write start as a time');
		expect(messageOf(await googleConnector.create(target, BLANK, null))).toContain('Say when the event starts');
		expect(messageOf(await googleConnector.create(target, {...BLANK, start: '2026-10-15', end: '2026-10-15T10:00'}, null))).toBe(
			'Write start and end both as days, for an all-day event, or both as times',
		);
		expect(messageOf(await googleConnector.create(target, {...BLANK, start: '2026-10-15T09:00', guests: 'sam'}, null))).toBe('Write each guest as their email address, not “sam”');
		expect(google.requests.filter((request) => request.method === 'POST')).toEqual([]);
	});
});

describe('editing', () => {
	test('only what was written differently is sent, and an event without guests tells no one', async () => {
		const {googleConnector} = await import('./google-connector');
		const before = (await googleConnector.get(target, 'alex@example.com:ev1')).unwrap();
		google.requests = [];
		await googleConnector.update(target, 'alex@example.com:ev1', {...before.values, title: 'Deep work'}, before);

		const patch = google.requests.find((request) => request.method === 'PATCH');
		expect(JSON.parse(patch?.body ?? '')).toEqual({summary: 'Deep work'});
		expect(patch?.url.searchParams.get('sendUpdates')).toBe('none');
	});

	test('a start moved without a new end keeps the event as long as it was', async () => {
		const {googleConnector} = await import('./google-connector');
		const before = (await googleConnector.get(target, 'alex@example.com:ev1')).unwrap();
		await googleConnector.update(target, 'alex@example.com:ev1', {...before.values, start: '2026-10-16T13:00'}, before);
		await googleConnector.update(target, 'alex@example.com:ev3', {...BLANK, title: 'Offsite', start: '2026-10-27', end: '2026-10-21'});

		const [moved, offsite] = google.requests.filter((request) => request.method === 'PATCH').map((request) => JSON.parse(request.body));
		expect(moved).toEqual({start: {dateTime: '2026-10-16T13:00:00', timeZone: 'Europe/Berlin'}, end: {dateTime: '2026-10-16T15:00:00', timeZone: 'Europe/Berlin'}});
		expect(offsite).toEqual({start: {date: '2026-10-27'}, end: {date: '2026-10-29'}});
	});

	test('changing the guests keeps the account, the rooms and the answers of those still invited, and Google tells them', async () => {
		const {googleConnector} = await import('./google-connector');
		const before = (await googleConnector.get(target, 'alex@example.com:ev2')).unwrap();
		await googleConnector.update(target, 'alex@example.com:ev2', {...before.values, guests: 'sam@example.com, kim@example.com'}, before);

		const patch = google.requests.find((request) => request.method === 'PATCH');
		expect(patch?.url.searchParams.get('sendUpdates')).toBe('all');
		expect(JSON.parse(patch?.body ?? '')).toEqual({
			attendees: [
				{email: 'sam@example.com', displayName: 'Sam Lee', organizer: true, responseStatus: 'accepted'},
				{email: 'alex@example.com', self: true, responseStatus: 'needsAction'},
				{email: 'room-3@resource.calendar.google.com', resource: true, responseStatus: 'accepted'},
				{email: 'kim@example.com'},
			],
		});
	});

	test('nothing written differently sends nothing', async () => {
		const {googleConnector} = await import('./google-connector');
		const before = (await googleConnector.get(target, 'alex@example.com:ev2')).unwrap();
		await googleConnector.update(target, 'alex@example.com:ev2', {...before.values}, before);

		expect(google.requests.filter((request) => request.method === 'PATCH')).toEqual([]);
	});
});

describe('answering an invitation', () => {
	test("sets the account's own answer and tells the organizer", async () => {
		const {googleConnector} = await import('./google-connector');
		const record = (await googleConnector.commands?.accept?.(target, 'alex@example.com:ev2'))?.unwrap();

		const patch = google.requests.find((request) => request.method === 'PATCH');
		expect(patch?.url.searchParams.get('sendUpdates')).toBe('all');
		expect(JSON.parse(patch?.body ?? '').attendees[1]).toEqual({email: 'alex@example.com', self: true, responseStatus: 'accepted'});
		expect(record?.values.response).toBe('Accepted');
	});

	test("the account's own event is not answered", async () => {
		const {googleConnector} = await import('./google-connector');
		const result = await googleConnector.commands?.decline?.(target, 'alex@example.com:ev1');

		expect(messageOf(result)).toBe('Only an event someone else invited you to is answered');
		expect(google.requests.filter((request) => request.method === 'PATCH')).toEqual([]);
	});
});
