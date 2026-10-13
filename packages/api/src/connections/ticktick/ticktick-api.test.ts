import {afterAll, beforeEach, describe, expect, spyOn, test} from 'bun:test';

import {checkToken, completeTask, createTask, getProjectData, getTask, listProjects, updateTask} from './ticktick-api';

// TickTick's answers, as its Open API sends them, with made-up ids, names and times.
const PROJECTS = [
	{id: '64f0a1b2c3d4e5f6a7b8c901', name: 'Errands', sortOrder: 0, viewMode: 'list', kind: 'TASK'},
	{id: '64f0a1b2c3d4e5f6a7b8c902', name: 'Ideas', color: '#4CA1FF', sortOrder: -1048576, closed: false, viewMode: 'kanban', permission: 'write', kind: 'TASK'},
	{id: '64f0a1b2c3d4e5f6a7b8c903', name: 'Journal', sortOrder: 549755813888, viewMode: 'list', permission: 'write', kind: 'NOTE'},
];

const TASK = {
	id: '64f0a1b2c3d4e5f6a7b8c9a1',
	projectId: '64f0a1b2c3d4e5f6a7b8c901',
	sortOrder: -1099511627777,
	title: 'Buy milk',
	content: 'Oat, if they have it',
	startDate: '2026-10-20T08:00:00.000+0000',
	dueDate: '2026-10-20T08:00:00.000+0000',
	timeZone: 'Europe/Berlin',
	isAllDay: false,
	priority: 3,
	isFloating: false,
	reminders: ['TRIGGER:PT0S'],
	status: 0,
	tags: ['errand'],
	etag: 'abcd1234',
	etimestamp: 1791916782534,
	kind: 'TEXT',
	modifiedTime: '2026-10-13T18:39:42.531+0000',
	createdTime: '2026-10-13T18:39:42.531+0000',
};

const CHECKLIST = {
	id: '64f0a1b2c3d4e5f6a7b8c9a2',
	projectId: 'inbox100000001',
	sortOrder: -357616180658176,
	title: 'Pack',
	content: '',
	desc: 'For the weekend',
	timeZone: 'Europe/Berlin',
	isAllDay: false,
	priority: 0,
	progress: 0,
	isFloating: false,
	repeatFlag: '',
	status: 0,
	items: [
		{id: '64f0a1b2c3d4e5f6a7b8c9b1', status: 1, title: 'Socks', sortOrder: 0, isAllDay: false, timeZone: 'Europe/Berlin'},
		{id: '64f0a1b2c3d4e5f6a7b8c9b2', status: 0, title: 'Charger', sortOrder: 1, isAllDay: false, timeZone: 'Europe/Berlin'},
	],
	columnId: '64f0a1b2c3d4e5f6a7b8c9c1',
	etag: 'efgh5678',
	etimestamp: 1741075064290,
	kind: 'CHECKLIST',
	modifiedTime: '2025-03-04T07:57:41.000+0000',
	createdTime: '2025-02-17T11:18:13.000+0000',
};

type Reply = {status: number; body: string};
const sent: {url: string; init: RequestInit | undefined}[] = [];
let reply: Reply = {status: 200, body: ''};

function json(status: number, body: unknown): Reply {
	return {status, body: JSON.stringify(body)};
}

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
	sent.push({url: String(input), init});
	return new Response(reply.body === '' ? null : reply.body, {status: reply.status, headers: reply.body === '' ? {} : {'content-type': 'application/json'}});
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

beforeEach(() => {
	sent.length = 0;
	reply = {status: 200, body: ''};
});

function header(init: RequestInit | undefined, name: string): string | null {
	return new Headers(init?.headers).get(name);
}

describe('reading', () => {
	test("lists the account's lists with the token in the Authorization header alone", async () => {
		reply = json(200, PROJECTS);
		const projects = (await listProjects('tp_secret')).unwrap();

		expect(projects.map((project) => [project.id, project.name, project.kind])).toEqual([
			['64f0a1b2c3d4e5f6a7b8c901', 'Errands', 'TASK'],
			['64f0a1b2c3d4e5f6a7b8c902', 'Ideas', 'TASK'],
			['64f0a1b2c3d4e5f6a7b8c903', 'Journal', 'NOTE'],
		]);
		expect(sent[0]?.url).toBe('https://api.ticktick.com/open/v1/project');
		expect(sent[0]?.url).not.toContain('tp_secret');
		expect(header(sent[0]?.init, 'authorization')).toBe('Bearer tp_secret');
	});

	test("reads a list's tasks, and the Inbox's, which come without a list", async () => {
		reply = json(200, {project: PROJECTS[0], tasks: [TASK], columns: []});
		const list = (await getProjectData('tp_secret', '64f0a1b2c3d4e5f6a7b8c901')).unwrap();
		expect(list?.project?.name).toBe('Errands');
		expect(list?.tasks[0]).toMatchObject({id: TASK.id, title: 'Buy milk', priority: 3, status: 0, tags: ['errand']});

		reply = json(200, {tasks: [CHECKLIST], columns: []});
		const inbox = (await getProjectData('tp_secret', 'inbox')).unwrap();
		expect(sent[1]?.url).toBe('https://api.ticktick.com/open/v1/project/inbox/data');
		expect(inbox).toEqual({
			project: null,
			tasks: [
				expect.objectContaining({
					projectId: 'inbox100000001',
					desc: 'For the weekend',
					items: [
						{title: 'Socks', status: 1},
						{title: 'Charger', status: 0},
					],
				}),
			],
		});
	});

	test("a list TickTick doesn't have is null, as it answers one with {}", async () => {
		reply = json(200, {});
		expect((await getProjectData('tp_secret', '000000000000000000000000')).unwrap()).toBeNull();
	});

	test("a task TickTick doesn't have is not found", async () => {
		reply = json(404, {errorId: 'abc@server-1', errorCode: 'resource_not_found', errorMessage: 'task not found: 000000000000000000000000', data: null});
		expect((await getTask('tp_secret', '64f0a1b2c3d4e5f6a7b8c901', '000000000000000000000000')).unwrapErr().kind).toBe('not_found');
	});
});

describe('errors', () => {
	test("a refused token is credentials_rejected, and TickTick's answer, which repeats it, is dropped", async () => {
		reply = json(401, {error: 'invalid_token', error_description: 'Invalid access token: tp_secret', errors: [{message: 'Invalid access token: tp_secret'}]});
		const error = (await checkToken('tp_secret')).unwrapErr();
		expect(error).toEqual({kind: 'credentials_rejected', statusCode: 422});
		expect(JSON.stringify(error)).not.toContain('tp_secret');
	});

	test('its rate limit says to wait, and anything else is TickTick out of reach, without its answer', async () => {
		reply = json(429, {errorCode: 'exceed_query_limit'});
		expect((await listProjects('tp_secret')).unwrapErr()).toMatchObject({kind: 'rate_limited', statusCode: 429, message: expect.stringContaining('Try again')});

		reply = json(500, {errorCode: 'unknown', errorMessage: 'tp_secret'});
		const error = (await listProjects('tp_secret')).unwrapErr();
		expect(error.kind).toBe('provider_unreachable');
		expect(error.kind === 'provider_unreachable' && String(error.cause)).toBe('Error: TickTick answered 500 (unknown) to https://api.ticktick.com/open/v1/project');
	});

	test('an answer that is not a task is TickTick out of reach', async () => {
		reply = json(200, {id: 42});
		expect((await getTask('tp_secret', 'p', 't')).unwrapErr().kind).toBe('provider_unreachable');
	});
});

describe('writing', () => {
	test('a new task is posted with what was written', async () => {
		reply = json(200, {...TASK, title: 'Call the bank', content: '', priority: 0, tags: []});
		const created = (await createTask('tp_secret', {title: 'Call the bank', projectId: '64f0a1b2c3d4e5f6a7b8c901', priority: 0})).unwrap();

		expect(created.title).toBe('Call the bank');
		expect(sent[0]?.url).toBe('https://api.ticktick.com/open/v1/task');
		expect(sent[0]?.init?.method).toBe('POST');
		expect(header(sent[0]?.init, 'content-type')).toBe('application/json');
		expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({title: 'Call the bank', projectId: '64f0a1b2c3d4e5f6a7b8c901', priority: 0});
	});

	test('an update sends the task, its list and only the fields given', async () => {
		reply = json(200, {...TASK, priority: 5});
		await updateTask('tp_secret', {id: TASK.id, projectId: TASK.projectId}, {priority: 5});

		expect(sent[0]?.url).toBe(`https://api.ticktick.com/open/v1/task/${TASK.id}`);
		expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({id: TASK.id, projectId: TASK.projectId, priority: 5});
	});

	test('completing takes the empty answer TickTick gives', async () => {
		reply = {status: 200, body: ''};
		expect((await completeTask('tp_secret', 'inbox100000001', CHECKLIST.id)).isOk()).toBe(true);
		expect(sent[0]?.url).toBe(`https://api.ticktick.com/open/v1/project/inbox100000001/task/${CHECKLIST.id}/complete`);
		expect(sent[0]?.init?.method).toBe('POST');
	});

	test('ids are put in the path escaped', async () => {
		reply = json(200, TASK);
		await getTask('tp_secret', '../x', 'a/b');
		expect(sent[0]?.url).toBe('https://api.ticktick.com/open/v1/project/..%2Fx/task/a%2Fb');
	});
});
