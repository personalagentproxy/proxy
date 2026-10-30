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

function tasks(): Collection {
	const integration = findIntegration('google');
	const found = integration && findCollection(integration, 'tasks');
	if (!found) {
		throw new Error('No tasks collection');
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
	collection: tasks(),
};

const MINE = {id: 'TUlORQ', title: 'My Tasks', updated: '2026-10-10T08:00:00.000Z'};
const ERRANDS = {id: 'RVJSQU5EUw', title: 'Errands', updated: '2026-10-11T08:00:00.000Z'};

// A task made from an email in Gmail, a subtask under it, and one done.
const REPLY = {
	id: 'UkVQTFk',
	title: 'Reply to Dana about pricing',
	notes: 'Send the new tiers',
	status: 'needsAction',
	due: '2026-10-20T00:00:00.000Z',
	updated: '2026-10-12T08:00:00.000Z',
	webViewLink: 'https://tasks.google.com/task/UkVQTFk',
	links: [{type: 'email', description: 'Pricing review', link: 'https://mail.google.com/mail/#all/18f'}],
};
const DRAFT = {id: 'RFJBRlQ', title: 'Draft the tiers', status: 'needsAction', parent: 'UkVQTFk', updated: '2026-10-12T09:00:00.000Z'};
const BOOKED = {id: 'Qk9PS0VE', title: 'Book the venue', status: 'completed', completed: '2026-10-09T10:00:00.000Z', updated: '2026-10-09T10:00:00.000Z', hidden: true};

const TASKS: Record<string, object> = {UkVQTFk: REPLY, RFJBRlQ: DRAFT, Qk9PS0VE: BOOKED};
const LISTS: Record<string, object> = {TUlORQ: MINE, RVJSQU5EUw: ERRANDS, '@default': MINE};

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
	const path = decodeURIComponent(url.pathname);
	if (path === '/tasks/v1/users/@me/lists') {
		return Response.json({items: [MINE, ERRANDS]});
	}
	if (path.startsWith('/tasks/v1/users/@me/lists/')) {
		const list = LISTS[path.split('/').at(-1) ?? ''];
		return list ? Response.json(list) : Response.json({error: {code: 404, message: 'Not Found'}}, {status: 404});
	}
	if (path.endsWith('/move')) {
		return Response.json({...REPLY, id: 'TU9WRUQ'});
	}
	if (path.endsWith('/tasks') && request.method === 'GET') {
		return Response.json({items: [REPLY, DRAFT, BOOKED], nextPageToken: 'google-page-2'});
	}
	if (path.endsWith('/tasks') && request.method === 'POST') {
		return Response.json({id: 'TkVX', status: 'needsAction', updated: '2026-10-13T08:00:00.000Z', ...JSON.parse(request.body)});
	}
	const task = TASKS[path.split('/').at(-1) ?? ''];
	if (!task) {
		return Response.json({error: {code: 404, message: 'Not Found'}}, {status: 404});
	}
	// Google leaves out what was cleared.
	if (request.method === 'PATCH') {
		return Response.json(Object.fromEntries(Object.entries({...task, ...JSON.parse(request.body)}).filter(([, value]) => value !== null)));
	}
	return Response.json(task);
}) as typeof fetch);

beforeEach(() => {
	google.requests = [];
	google.answer = () => null;
});

const query = (rest: Partial<{search: string | null; page: string | null; filter: string | null; parent: string | null}> = {}) => ({search: null, page: null, filter: null, parent: null, ...rest});

describe('listing tasks', () => {
	test('the top is the account’s task lists, each holding its tasks', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const page = (await tasksConnector.list(target, query())).unwrap();

		expect(page).toEqual({
			records: [
				{id: 'TUlORQ', values: {title: 'My Tasks', kind: 'List'}, updatedAt: '2026-10-10T08:00:00.000Z', hasChildren: true},
				{id: 'RVJSQU5EUw', values: {title: 'Errands', kind: 'List'}, updatedAt: '2026-10-11T08:00:00.000Z', hasChildren: true},
			],
			nextPage: null,
		});
	});

	test('a list holds its tasks, done and hidden ones too, a subtask saying the task it is under', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const page = (await tasksConnector.list(target, query({parent: 'TUlORQ'}))).unwrap();

		const request = google.requests.find((one) => one.url.pathname.endsWith('/tasks'));
		expect(request?.url.pathname).toBe('/tasks/v1/lists/TUlORQ/tasks');
		expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({maxResults: '50', showCompleted: 'true', showHidden: 'true', showAssigned: 'true'});
		expect(page.trail).toEqual([{id: 'TUlORQ', title: 'My Tasks'}]);
		expect(page.nextPage).toBe('google-page-2');
		expect(page.records[0]).toEqual({
			id: 'TUlORQ:UkVQTFk',
			values: {
				title: 'Reply to Dana about pricing',
				kind: 'Task',
				notes: 'Send the new tiers',
				due: '2026-10-20',
				list: 'My Tasks',
				status: 'Needs action',
				completed: '',
				subtaskOf: '',
				source: 'https://mail.google.com/mail/#all/18f',
			},
			updatedAt: '2026-10-12T08:00:00.000Z',
			url: 'https://tasks.google.com/task/UkVQTFk',
		});
		expect(page.records.slice(1).map((record) => [record.values.subtaskOf, record.values.status, record.values.completed])).toEqual([
			['Reply to Dana about pricing', 'Needs action', ''],
			['', 'Done', '2026-10-09T10:00:00.000Z'],
		]);
	});

	test('narrowed to those still to do, done ones are left out; to those done, only they are asked for', async () => {
		const {tasksConnector} = await import('./google-tasks');
		await tasksConnector.list(target, query({parent: 'TUlORQ', filter: 'Needs action'}));
		await tasksConnector.list(target, query({parent: 'TUlORQ', filter: 'Done', page: 'google-page-2'}));

		const [open, done] = google.requests.filter((one) => one.url.pathname.endsWith('/tasks')).map((one) => Object.fromEntries(one.url.searchParams));
		expect(open).toEqual({maxResults: '50', showCompleted: 'false', showHidden: 'false', showAssigned: 'true'});
		expect(done).toEqual({maxResults: '50', showCompleted: 'true', showHidden: 'true', showAssigned: 'true', completedMin: '1970-01-01T00:00:00.000Z', pageToken: 'google-page-2'});
	});

	test('a task holds nothing, and a list Google doesn’t have is not found', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const inTask = await tasksConnector.list(target, query({parent: 'TUlORQ:UkVQTFk'}));
		const missing = await tasksConnector.list(target, query({parent: 'Tk9QRQ'}));

		expect(messageOf(inTask)).toBe('Tasks hold nothing: give a list’s id as parent');
		expect(missing.isErr() && missing.error.kind).toBe('not_found');
	});
});

describe('opening a task', () => {
	test('a subtask opens with the title of the task it is under', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const record = (await tasksConnector.get(target, 'TUlORQ:RFJBRlQ')).unwrap();

		expect(record.values.subtaskOf).toBe('Reply to Dana about pricing');
	});

	test('a list opens as itself', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const record = (await tasksConnector.get(target, 'RVJSQU5EUw')).unwrap();

		expect(record.values).toEqual({title: 'Errands', kind: 'List'});
	});
});

describe('making a task', () => {
	test('in the list it is made inside, with its notes and due day', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const record = (await tasksConnector.create(target, {title: 'Call the venue', notes: 'Ask about parking', due: '2026-10-21', list: ''}, 'RVJSQU5EUw')).unwrap();

		const post = google.requests.find((one) => one.method === 'POST');
		expect(post?.url.pathname).toBe('/tasks/v1/lists/RVJSQU5EUw/tasks');
		expect(JSON.parse(post?.body ?? '')).toEqual({title: 'Call the venue', notes: 'Ask about parking', due: '2026-10-21T00:00:00.000Z'});
		expect(record.id).toBe('RVJSQU5EUw:TkVX');
		expect(record.values.list).toBe('Errands');
	});

	test('in the list named, else in the default one', async () => {
		const {tasksConnector} = await import('./google-tasks');
		await tasksConnector.create(target, {title: 'Buy stamps', notes: '', due: '', list: 'errands'}, null);
		const named = google.requests.find((one) => one.method === 'POST');
		google.requests = [];
		const record = (await tasksConnector.create(target, {title: 'Buy stamps', notes: '', due: '', list: ''}, null)).unwrap();

		expect(named?.url.pathname).toBe('/tasks/v1/lists/RVJSQU5EUw/tasks');
		expect(google.requests.map((one) => decodeURIComponent(one.url.pathname))).toEqual(['/tasks/v1/users/@me/lists/@default', '/tasks/v1/lists/TUlORQ/tasks']);
		expect(record.id).toBe('TUlORQ:TkVX');
	});

	test('no title, a due date with a time, or a list there isn’t, is turned down', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const results = await Promise.all([
			tasksConnector.create(target, {title: ' ', notes: '', due: '', list: ''}, 'TUlORQ'),
			tasksConnector.create(target, {title: 'Call', notes: '', due: '2026-10-21T09:00', list: ''}, 'TUlORQ'),
			tasksConnector.create(target, {title: 'Call', notes: '', due: '', list: 'Groceries'}, null),
		]);

		expect(results.map(messageOf)).toEqual([
			'A task needs a title',
			'Write due as a day, 2026-10-15, since Google Tasks keeps no time of day, not “2026-10-21T09:00”',
			'No task list is called “Groceries”: write one of My Tasks, Errands',
		]);
		expect(google.requests.filter((one) => one.method === 'POST')).toEqual([]);
	});
});

describe('editing a task', () => {
	test('only what was written differently changes, and an empty due day takes it off', async () => {
		const {tasksConnector} = await import('./google-tasks');
		await tasksConnector.update(target, 'TUlORQ:UkVQTFk', {title: 'Reply to Dana about pricing', notes: 'Send the new tiers and the FAQ', due: '', list: 'My Tasks'});

		const patch = google.requests.find((one) => one.method === 'PATCH');
		expect(patch?.url.pathname).toBe('/tasks/v1/lists/TUlORQ/tasks/UkVQTFk');
		expect(JSON.parse(patch?.body ?? '')).toEqual({notes: 'Send the new tiers and the FAQ', due: null});
	});

	test('writing another list’s name moves the task there', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const record = (await tasksConnector.update(target, 'TUlORQ:UkVQTFk', {title: 'Reply to Dana about pricing', notes: 'Send the new tiers', due: '2026-10-20', list: 'Errands'})).unwrap();

		const move = google.requests.find((one) => one.url.pathname.endsWith('/move'));
		expect(move?.method).toBe('POST');
		expect(move?.url.pathname).toBe('/tasks/v1/lists/TUlORQ/tasks/UkVQTFk/move');
		expect(move?.url.searchParams.get('destinationTasklist')).toBe('RVJSQU5EUw');
		expect(google.requests.some((one) => one.method === 'PATCH')).toBe(false);
		expect(record.id).toBe('RVJSQU5EUw:TU9WRUQ');
		expect(record.values.list).toBe('Errands');
	});

	test('nothing written differently changes nothing', async () => {
		const {tasksConnector} = await import('./google-tasks');
		await tasksConnector.update(target, 'TUlORQ:UkVQTFk', {title: 'Reply to Dana about pricing', notes: 'Send the new tiers', due: '2026-10-20', list: 'My Tasks'});

		expect(google.requests.filter((one) => one.method !== 'GET')).toEqual([]);
	});
});

describe('completing and reopening', () => {
	test('completing marks the task done; reopening marks it to do again and clears when it was done', async () => {
		const {tasksConnector} = await import('./google-tasks');
		const completed = (await tasksConnector.commands?.complete?.(target, 'TUlORQ:UkVQTFk'))?.unwrap();
		const reopened = (await tasksConnector.commands?.reopen?.(target, 'TUlORQ:Qk9PS0VE'))?.unwrap();

		const patches = google.requests.filter((one) => one.method === 'PATCH').map((one) => JSON.parse(one.body));
		expect(patches).toEqual([{status: 'completed'}, {status: 'needsAction', completed: null}]);
		expect(completed?.values.status).toBe('Done');
		expect(reopened?.values.status).toBe('Needs action');
	});
});
