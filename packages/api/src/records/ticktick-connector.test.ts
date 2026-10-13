import {afterAll, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import {findCollection, findIntegration, type Collection} from '@proxy/integrations';

import type {RecordTarget} from './connector';

mock.module('../utils/secret-crypto', () => ({decryptSecret: () => Ok(JSON.stringify({token: 'tp_secret'}))}));

function tasks(): Collection {
	const integration = findIntegration('ticktick');
	const found = integration && findCollection(integration, 'tasks');
	if (!found) {
		throw new Error('No tasks collection');
	}
	return found;
}

const target: RecordTarget = {
	connection: {id: 'ticktick-1', integrationId: 'ticktick', account: 'alex@example.com', createdAt: new Date(), defaults: [], credential: 'v1.encrypted'},
	collection: tasks(),
};

const query = (changes: object = {}) => ({search: null, page: null, filter: null, parent: null, ...changes});

const ERRANDS = '64f0a1b2c3d4e5f6a7b8c901';
const IDEAS = '64f0a1b2c3d4e5f6a7b8c902';
const INBOX = 'inbox100000001';

const PROJECTS = [
	{id: ERRANDS, name: 'Errands', sortOrder: 1099511627776, viewMode: 'list', kind: 'TASK'},
	{id: IDEAS, name: 'Ideas', sortOrder: -1048576, viewMode: 'kanban', kind: 'TASK'},
	{id: '64f0a1b2c3d4e5f6a7b8c903', name: 'Journal', sortOrder: 0, viewMode: 'list', kind: 'NOTE'},
	{id: '64f0a1b2c3d4e5f6a7b8c904', name: 'Old errands', sortOrder: 0, closed: true, viewMode: 'list', kind: 'TASK'},
];

type Task = Record<string, unknown> & {id: string; projectId: string};

function task(id: string, projectId: string, changes: Record<string, unknown> = {}): Task {
	return {
		id,
		projectId,
		sortOrder: 0,
		title: `Task ${id.slice(-2)}`,
		content: '',
		timeZone: 'Europe/Berlin',
		isAllDay: false,
		priority: 0,
		isFloating: false,
		status: 0,
		etag: 'abcd1234',
		kind: 'TEXT',
		modifiedTime: '2026-10-01T08:00:00.000+0000',
		createdTime: '2026-10-01T08:00:00.000+0000',
		...changes,
	};
}

const MILK = task('64f0a1b2c3d4e5f6a7b8c9a1', ERRANDS, {
	title: 'Buy milk',
	content: 'Oat, if they have it',
	priority: 3,
	tags: ['errand', 'shop'],
	dueDate: '2026-10-20T08:00:00.000+0000',
	startDate: '2026-10-19T22:00:00.000+0000',
	reminders: ['TRIGGER:PT0S'],
	modifiedTime: '2026-10-13T18:39:42.531+0000',
});

// A TickTick account, answering as its Open API does: lists, their open tasks, and the Inbox.
let store: Task[] = [];
let refuseToken = false;
const sent: {method: string; path: string; body: unknown}[] = [];

function reply(status: number, body?: unknown): Response {
	return new Response(body === undefined ? null : JSON.stringify(body), {status, headers: body === undefined ? {} : {'content-type': 'application/json'}});
}

function answer(method: string, path: string, body: unknown): Response {
	if (refuseToken) {
		return reply(401, {error: 'invalid_token', error_description: 'Invalid access token: tp_secret'});
	}
	if (method === 'GET' && path === '/project') {
		return reply(200, PROJECTS);
	}
	const data = path.match(/^\/project\/([^/]+)\/data$/);
	if (method === 'GET' && data) {
		const id = data[1] === 'inbox' ? INBOX : data[1];
		const project = PROJECTS.find((candidate) => candidate.id === id);
		if (!project && id !== INBOX) {
			return reply(200, {});
		}
		const open = store.filter((candidate) => candidate.projectId === id && candidate.status === 0);
		return reply(200, project ? {project, tasks: open, columns: []} : {tasks: open, columns: []});
	}
	const one = path.match(/^\/project\/([^/]+)\/task\/([^/]+)(\/complete)?$/);
	const found = one && store.find((candidate) => candidate.id === one[2] && (candidate.projectId === one[1] || (one[1] === 'inbox' && candidate.projectId === INBOX)));
	if (method === 'GET' && one) {
		return found ? reply(200, found) : reply(404, {errorCode: 'resource_not_found', errorMessage: `task not found: ${one[2]}`});
	}
	// Completing answers nothing, whether or not there is such a task.
	if (method === 'POST' && one?.[3]) {
		if (found) {
			Object.assign(found, {status: 2});
		}
		return reply(200);
	}
	if (method === 'POST' && path === '/task') {
		const written = body as Record<string, unknown>;
		const created = task('64f0a1b2c3d4e5f6a7b8c9ff', String(written.projectId ?? INBOX), written);
		store.push(created);
		return reply(200, created);
	}
	const edit = path.match(/^\/task\/([^/]+)$/);
	if (method === 'POST' && edit) {
		const existing = store.find((candidate) => candidate.id === edit[1]);
		if (!existing) {
			return reply(200);
		}
		Object.assign(existing, body);
		return reply(200, existing);
	}
	return reply(500, {errorCode: 'unexpected'});
}

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	const path = String(input).replace('https://api.ticktick.com/open/v1', '');
	const method = init?.method ?? 'GET';
	const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
	sent.push({method, path, body});
	return answer(method, path, body);
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

beforeEach(() => {
	sent.length = 0;
	refuseToken = false;
	store = [
		structuredClone(MILK),
		task('64f0a1b2c3d4e5f6a7b8c9a2', ERRANDS, {title: 'Post the parcel', modifiedTime: '2026-10-14T09:00:00.000+0000'}),
		task('64f0a1b2c3d4e5f6a7b8c9a3', ERRANDS, {title: 'A note', kind: 'NOTE'}),
		task('64f0a1b2c3d4e5f6a7b8c9a4', INBOX, {
			title: 'Pack',
			kind: 'CHECKLIST',
			desc: 'For the weekend',
			isAllDay: true,
			dueDate: '2026-10-24T22:00:00.000+0000',
			items: [
				{id: '1', title: 'Socks', status: 1},
				{id: '2', title: 'Charger', status: 0},
			],
		}),
	];
});

describe('list', () => {
	test('the top is the Inbox, then the lists of tasks in TickTick’s order, archived ones and lists of notes left out', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const page = (await ticktickConnector.list(target, query())).unwrap();

		expect(page.records.map((record) => [record.id, record.values.title, record.hasChildren])).toEqual([
			['project:inbox', 'Inbox', true],
			[`project:${IDEAS}`, 'Ideas', true],
			[`project:${ERRANDS}`, 'Errands', true],
		]);
		expect(page.nextPage).toBeNull();
	});

	test('inside a list, its open tasks changed last first, without notes, with where they are', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const page = (await ticktickConnector.list(target, query({parent: `project:${ERRANDS}`}))).unwrap();

		expect(page.records.map((record) => record.values.title)).toEqual(['Post the parcel', 'Buy milk']);
		expect(page.records[1]).toEqual({
			id: `task:${ERRANDS}:${MILK.id}`,
			values: {
				title: 'Buy milk',
				kind: 'Task',
				status: 'Open',
				list: 'Errands',
				priority: 'Medium',
				startDate: '2026-10-20 00:00 (Europe/Berlin)',
				dueDate: '2026-10-20 10:00 (Europe/Berlin)',
				tags: 'errand, shop',
				checklist: '',
				link: `https://ticktick.com/webapp/#p/${ERRANDS}/tasks/${MILK.id}`,
				updated: '2026-10-13T18:39:42.531Z',
				content: 'Oat, if they have it',
			},
			updatedAt: '2026-10-13T18:39:42.531Z',
		});
		expect(page.trail).toEqual([{id: `project:${ERRANDS}`, title: 'Errands'}]);
	});

	test('the Inbox’s tasks carry its own id, a checklist its items and description, a day without a time', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const page = (await ticktickConnector.list(target, query({parent: 'project:inbox'}))).unwrap();

		expect(page.records[0]?.id).toBe(`task:${INBOX}:64f0a1b2c3d4e5f6a7b8c9a4`);
		expect(page.records[0]?.values).toMatchObject({list: 'Inbox', content: 'For the weekend', checklist: '[x] Socks\n[ ] Charger', dueDate: '2026-10-25'});
		expect(page.trail).toEqual([{id: 'project:inbox', title: 'Inbox'}]);
	});

	test('searches list names at the top and task titles and notes inside a list', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const top = (await ticktickConnector.list(target, query({search: 'err'}))).unwrap();
		const inside = (await ticktickConnector.list(target, query({parent: `project:${ERRANDS}`, search: 'OAT milk'}))).unwrap();

		expect(top.records.map((record) => record.values.title)).toEqual(['Errands']);
		expect(inside.records.map((record) => record.values.title)).toEqual(['Buy milk']);
	});

	test('pages 50 tasks at a time', async () => {
		store = Array.from({length: 120}, (_, index) =>
			task(`64f0a1b2c3d4e5f6a7b8${String(index).padStart(4, '0')}`, ERRANDS, {modifiedTime: `2026-10-01T08:${String(index % 60).padStart(2, '0')}:00.000+0000`}),
		);
		const {ticktickConnector} = await import('./ticktick-connector');
		const first = (await ticktickConnector.list(target, query({parent: `project:${ERRANDS}`}))).unwrap();
		const last = (await ticktickConnector.list(target, query({parent: `project:${ERRANDS}`, page: '100'}))).unwrap();

		expect(first.records).toHaveLength(50);
		expect(first.nextPage).toBe('50');
		expect(last.records).toHaveLength(20);
		expect(last.nextPage).toBeNull();
		expect((await ticktickConnector.list(target, query({parent: `project:${ERRANDS}`, page: 'x'}))).unwrapErr().kind).toBe('validation_error');
	});

	test('a list TickTick doesn’t have, or an id that isn’t one, is not found; a task holds no tasks', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');

		expect((await ticktickConnector.list(target, query({parent: 'project:000000000000000000000000'}))).unwrapErr().kind).toBe('not_found');
		for (const bad of ['project:', 'project:../x', 'task:a', 'nonsense', `project:${ERRANDS}:extra`]) {
			expect((await ticktickConnector.list(target, query({parent: bad}))).unwrapErr().kind, bad).toBe('not_found');
		}
		expect((await ticktickConnector.list(target, query({parent: `task:${ERRANDS}:${MILK.id}`}))).unwrapErr().kind).toBe('validation_error');
	});

	test('a token TickTick turns down is credentials_rejected', async () => {
		refuseToken = true;
		const {ticktickConnector} = await import('./ticktick-connector');
		expect((await ticktickConnector.list(target, query())).unwrapErr().kind).toBe('credentials_rejected');
	});
});

describe('get', () => {
	test('opens a task by its list and id, and a list by its id', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');

		expect((await ticktickConnector.get(target, `task:${ERRANDS}:${MILK.id}`)).unwrap().values).toMatchObject({title: 'Buy milk', list: 'Errands'});
		expect((await ticktickConnector.get(target, `project:${ERRANDS}`)).unwrap()).toEqual({id: `project:${ERRANDS}`, values: {title: 'Errands', kind: 'List'}, updatedAt: '', hasChildren: true});
		expect((await ticktickConnector.get(target, 'project:inbox')).unwrap().values.title).toBe('Inbox');
	});

	test('a task TickTick doesn’t have, in another list, a note, or a malformed id, is not found', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');

		for (const id of [`task:${ERRANDS}:000000000000000000000000`, `task:${IDEAS}:${MILK.id}`, `task:${ERRANDS}:64f0a1b2c3d4e5f6a7b8c9a3`, 'task::', 'task:a/b:c', `project:000000000000000000000000`]) {
			expect((await ticktickConnector.get(target, id)).unwrapErr().kind, id).toBe('not_found');
		}
	});
});

describe('create', () => {
	test('adds a task to a list with what was written', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const created = (await ticktickConnector.create(target, {title: ' Call the bank ', priority: 'High', content: 'About the card'}, `project:${ERRANDS}`)).unwrap();

		expect(sent.at(-1)).toEqual({method: 'POST', path: '/task', body: {title: 'Call the bank', projectId: ERRANDS, content: 'About the card', priority: 5}});
		expect(created).toMatchObject({id: `task:${ERRANDS}:64f0a1b2c3d4e5f6a7b8c9ff`, values: {title: 'Call the bank', list: 'Errands', priority: 'High', status: 'Open'}});
	});

	test('in the Inbox, by its own id, read from its tasks', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const created = (await ticktickConnector.create(target, {title: 'Call mum', priority: '', content: ''}, 'project:inbox')).unwrap();

		expect(sent.at(-1)?.body).toEqual({title: 'Call mum', projectId: INBOX, priority: 0});
		expect(created.values.list).toBe('Inbox');
	});

	test('needs a list to go in, a title, and a list TickTick has', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');

		expect((await ticktickConnector.create(target, {title: 'Loose'}, null)).unwrapErr().kind).toBe('validation_error');
		expect((await ticktickConnector.create(target, {title: 'Nested'}, `task:${ERRANDS}:${MILK.id}`)).unwrapErr().kind).toBe('validation_error');
		expect((await ticktickConnector.create(target, {title: '  '}, `project:${ERRANDS}`)).unwrapErr().kind).toBe('validation_error');
		expect((await ticktickConnector.create(target, {title: 'Lost'}, 'project:000000000000000000000000')).unwrapErr().kind).toBe('not_found');
		expect(sent.some((request) => request.path === '/task')).toBe(false);
	});
});

describe('update', () => {
	test('sends only the fields written differently, so TickTick keeps the dates, tags and reminders', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const id = `task:${ERRANDS}:${MILK.id}`;
		const updated = (await ticktickConnector.update(target, id, {title: 'Buy milk', priority: 'High', content: 'Oat, if they have it'})).unwrap();

		expect(sent.at(-1)).toEqual({method: 'POST', path: `/task/${MILK.id}`, body: {id: MILK.id, projectId: ERRANDS, priority: 5}});
		expect(updated.values).toMatchObject({priority: 'High', tags: 'errand, shop', dueDate: '2026-10-20 10:00 (Europe/Berlin)', status: 'Open'});
		expect(store[0]).toMatchObject({reminders: ['TRIGGER:PT0S'], dueDate: MILK.dueDate, content: 'Oat, if they have it'});
	});

	test('nothing written differently sends nothing', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		await ticktickConnector.update(target, `task:${ERRANDS}:${MILK.id}`, {title: 'Buy milk ', priority: 'Medium', content: 'Oat, if they have it'});

		expect(sent.some((request) => request.method === 'POST')).toBe(false);
	});

	test('a checklist task’s notes are its description', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		await ticktickConnector.update(target, `task:${INBOX}:64f0a1b2c3d4e5f6a7b8c9a4`, {content: 'For Saturday'});

		expect(sent.at(-1)?.body).toEqual({id: '64f0a1b2c3d4e5f6a7b8c9a4', projectId: INBOX, desc: 'For Saturday'});
	});

	test('a list, an emptied title, and a task TickTick doesn’t have are refused before anything is sent', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');

		expect((await ticktickConnector.update(target, `project:${ERRANDS}`, {title: 'Chores'})).unwrapErr().kind).toBe('validation_error');
		expect((await ticktickConnector.update(target, `task:${ERRANDS}:${MILK.id}`, {title: ''})).unwrapErr().kind).toBe('validation_error');
		expect((await ticktickConnector.update(target, `task:${ERRANDS}:000000000000000000000000`, {title: 'Ghost'})).unwrapErr().kind).toBe('not_found');
		expect(sent.some((request) => request.method === 'POST')).toBe(false);
	});
});

describe('complete', () => {
	test('completes an open task, taking TickTick’s empty answer, and the task leaves the list', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const result = await ticktickConnector.commands?.complete?.(target, `task:${ERRANDS}:${MILK.id}`);

		expect(result?.unwrap()).toBeNull();
		expect(sent.at(-1)).toEqual({method: 'POST', path: `/project/${ERRANDS}/task/${MILK.id}/complete`, body: undefined});
		const page = (await ticktickConnector.list(target, query({parent: `project:${ERRANDS}`}))).unwrap();
		expect(page.records.map((record) => record.values.title)).toEqual(['Post the parcel']);
	});

	test('a task TickTick doesn’t have is not found rather than the silent success TickTick answers', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		const result = await ticktickConnector.commands?.complete?.(target, `task:${ERRANDS}:000000000000000000000000`);

		expect(result?.unwrapErr().kind).toBe('not_found');
		expect(sent.some((request) => request.path.endsWith('/complete'))).toBe(false);
	});

	test('a list, a malformed id and a task already completed are refused', async () => {
		const {ticktickConnector} = await import('./ticktick-connector');
		store[0] = {...store[0], ...MILK, status: 2};

		expect((await ticktickConnector.commands?.complete?.(target, `project:${ERRANDS}`))?.unwrapErr().kind).toBe('validation_error');
		expect((await ticktickConnector.commands?.complete?.(target, 'task:../../x'))?.unwrapErr().kind).toBe('not_found');
		expect((await ticktickConnector.commands?.complete?.(target, `task:${ERRANDS}:${MILK.id}`))?.unwrapErr().kind).toBe('validation_error');
		expect(sent.some((request) => request.path.endsWith('/complete'))).toBe(false);
	});

	test('a token TickTick turns down is credentials_rejected', async () => {
		refuseToken = true;
		const {ticktickConnector} = await import('./ticktick-connector');
		expect((await ticktickConnector.commands?.complete?.(target, `task:${ERRANDS}:${MILK.id}`))?.unwrapErr().kind).toBe('credentials_rejected');
	});
});

test('tasks are never deleted', async () => {
	const {ticktickConnector} = await import('./ticktick-connector');
	expect((await ticktickConnector.remove(target, `task:${ERRANDS}:${MILK.id}`)).unwrapErr().kind).toBe('validation_error');
	expect(sent).toEqual([]);
});
