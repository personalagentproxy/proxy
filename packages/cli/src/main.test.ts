import {afterAll, afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Ok} from 'ts-results-es';

import {main, type Io} from './main';
import {readSession, writeSession} from './session';

const ORIGIN = 'http://localhost:5173';
const COOKIE = 'proxy.agent-session';

type Sent = {url: string; method: string; headers: Headers; body: string | null};
const sent: Sent[] = [];
let server: (request: Sent) => Response = () => Response.json({});

const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (
	input: string | URL | Request,
	init?: RequestInit,
) => {
	const request = {
		url: String(input),
		method: init?.method ?? 'GET',
		headers: new Headers(init?.headers),
		body: typeof init?.body === 'string' ? init.body : null,
	};
	sent.push(request);
	return server(request);
}) as typeof fetch);

afterAll(() => {
	fetchSpy.mockRestore();
});

const ME = {
	agent: {id: 'agent-1', providerId: 'claude-code', name: 'Claude Code'},
	connections: [
		{
			id: 'conn-tt',
			integrationId: 'ticktick',
			account: 'alex@example.com',
			actions: ['read', 'edit'],
		},
	],
};

const TOOLS = {
	tools: [
		{
			name: 'tasks_list',
			title: 'List Tasks',
			description: 'List tasks, newest first.',
			readOnly: true,
			inputSchema: {
				type: 'object',
				properties: {
					parent: {type: 'string', description: 'Parent'},
					page: {type: 'string', description: 'Page'},
				},
				required: [],
				additionalProperties: false,
			},
		},
		{
			name: 'tasks_update',
			title: 'Edit task',
			description: 'Edit a task: only the fields given change.',
			readOnly: false,
			inputSchema: {
				type: 'object',
				properties: {
					id: {type: 'string', description: 'Id'},
					title: {type: 'string', description: 'Title'},
				},
				required: ['id'],
				additionalProperties: false,
			},
		},
	],
};

const PAGE = {
	records: [
		{
			id: 'task:inbox1:a1',
			values: {title: 'Buy milk', kind: 'Task', status: 'Open'},
			updatedAt: '2026-10-13T18:39:42.531Z',
		},
		{id: 'task:inbox1:a2', values: {title: '', kind: 'Task'}, updatedAt: ''},
	],
	nextPage: '50',
	trail: [{id: 'project:inbox', title: 'Inbox'}],
};

// A Personal Agent Proxy that knows one login, and answers its agent side.
function proxy(request: Sent): Response {
	const path = request.url.replace(ORIGIN, '');
	if (path === '/agent-auth/login') {
		const {username, password} = JSON.parse(request.body ?? '{}') as {
			username: string;
			password: string;
		};
		if (username !== 'claude-code-x1' || password !== 'hunter2') {
			return Response.json({error: 'unauthenticated'}, {status: 401});
		}
		return Response.json(
			{agentId: 'agent-1'},
			{
				headers: {
					'Set-Cookie': `${COOKIE}=tok123; Path=/; Expires=Tue, 20 Oct 2026 12:00:00 GMT; HttpOnly; SameSite=Lax`,
				},
			},
		);
	}
	if (request.headers.get('cookie') !== `${COOKIE}=tok123`) {
		return Response.json({error: 'unauthenticated'}, {status: 401});
	}
	if (path === '/agent-auth/logout') {
		return Response.json({ok: true});
	}
	if (path === '/api/agent/me') {
		return Response.json(ME);
	}
	if (path === '/api/agent/connections/conn-tt/tools') {
		return Response.json(TOOLS);
	}
	if (path === '/api/agent/connections/conn-tt/tools/tasks_list') {
		return Response.json(PAGE);
	}
	if (path === '/api/agent/connections/conn-tt/tools/tasks_update') {
		return Response.json({
			record: {
				id: 'task:inbox1:a1',
				values: {title: 'Buy oat milk', notes: 'Two\ncartons'},
				updatedAt: '',
			},
		});
	}
	if (path === '/api/agent/connections/conn-tt/tools/tasks_complete') {
		return Response.json({error: 'forbidden'}, {status: 403});
	}
	if (path === '/api/agent/connections/conn-tt/tools/tasks_create') {
		return Response.json(
			{
				error: 'validation_error',
				message: 'tasks_create takes no colour; it takes parent, title, priority, content',
			},
			{status: 400},
		);
	}
	return Response.json({error: 'not_found'}, {status: 404});
}

let dir = '';
let out = '';
let err = '';
let stdin = '';

function io(): Io {
	return {
		out: (text) => {
			out += text;
		},
		err: (text) => {
			err += text;
		},
		readPassword: async () => Ok('hunter2'),
		readStdin: async () => Ok(stdin),
		configDir: dir,
		now: () => new Date('2026-10-14T00:00:00Z'),
	};
}

async function proxyCli(...argv: string[]): Promise<number> {
	out = '';
	err = '';
	return main(argv, io());
}

const session = {
	origin: ORIGIN,
	cookie: {name: COOKIE, value: 'tok123'},
	expires: '2026-10-20T12:00:00.000Z',
};

beforeEach(async () => {
	dir = join(await mkdtemp(join(tmpdir(), 'proxy-cli-')), 'proxy');
	sent.length = 0;
	server = proxy;
	stdin = '';
});

afterEach(async () => {
	await rm(dir, {recursive: true, force: true});
});

describe('login', () => {
	test('signs in with the server’s own origin and the command line’s marker, and keeps the cookie 0600', async () => {
		expect(
			await proxyCli('login', '--url', `${ORIGIN}/connections`, '--username', 'claude-code-x1'),
		).toBe(0);

		const [login] = sent;
		expect(login?.url).toBe(`${ORIGIN}/agent-auth/login`);
		expect(login?.method).toBe('POST');
		expect(login?.headers.get('origin')).toBe(ORIGIN);
		expect(login?.headers.get('x-proxy-client')).toBe('cli');
		expect(JSON.parse(login?.body ?? '')).toEqual({
			username: 'claude-code-x1',
			password: 'hunter2',
		});
		expect((await readSession(dir)).unwrap()).toEqual(session);
		expect((await stat(join(dir, 'session.json'))).mode & 0o777).toBe(0o600);
		expect(out).toContain('Signed in as Claude Code.');
		expect(out).toContain('conn-tt  TickTick (alex@example.com)  Read tasks, Edit tasks');
	});

	test('takes the password from standard input without its newline', async () => {
		stdin = 'hunter2\n';
		expect(
			await proxyCli('login', '--url', ORIGIN, '--username', 'claude-code-x1', '--password-stdin'),
		).toBe(0);
	});

	test('a wrong password keeps nothing and exits 1', async () => {
		stdin = 'wrong';
		expect(
			await proxyCli('login', '--url', ORIGIN, '--username', 'claude-code-x1', '--password-stdin'),
		).toBe(1);
		expect(err).toBe('proxy: Wrong username or password\n');
		expect((await readSession(dir)).unwrap()).toBeNull();
	});

	test('a redirect is not followed, so nothing goes to another origin', async () => {
		server = () =>
			new Response(null, {
				status: 302,
				headers: {location: 'https://elsewhere.example.com/agent-auth/login'},
			});
		expect(await proxyCli('login', '--url', ORIGIN, '--username', 'claude-code-x1')).toBe(1);
		expect(err).toContain('redirect to https://elsewhere.example.com/agent-auth/login');
		expect(sent).toHaveLength(1);
	});

	test('an address that is plain HTTP to another machine is refused before the password is asked for', async () => {
		expect(
			await proxyCli('login', '--url', 'http://proxy.example.com', '--username', 'claude-code-x1'),
		).toBe(2);
		expect(sent).toHaveLength(0);
	});
});

describe('as the signed-in agent', () => {
	beforeEach(async () => {
		(await writeSession(dir, session)).unwrap();
	});

	test('connections reads the session’s origin only, with its cookie', async () => {
		expect(await proxyCli('connections')).toBe(0);
		expect(sent[0]?.url).toBe(`${ORIGIN}/api/agent/me`);
		expect(sent[0]?.headers.get('x-proxy-client')).toBe('cli');
	});

	test('--json prints the server’s answer', async () => {
		expect(await proxyCli('connections', '--json')).toBe(0);
		expect(JSON.parse(out)).toEqual(ME);
	});

	test('tools lists each with what it does and its params, the required ones starred', async () => {
		expect(await proxyCli('tools', 'conn-tt')).toBe(0);
		expect(out).toBe(
			'tasks_list  reads  List tasks, newest first.\n    params: parent, page\ntasks_update  changes  Edit a task: only the fields given change.\n    params: id*, title\n',
		);
	});

	test('run posts the params with the origin, and prints a page one record a line', async () => {
		expect(
			await proxyCli('run', 'conn-tt', 'tasks_list', '--params', '{"parent":"project:inbox"}'),
		).toBe(0);

		const [run] = sent;
		expect(run?.method).toBe('POST');
		expect(run?.headers.get('origin')).toBe(ORIGIN);
		expect(run?.headers.get('cookie')).toBe(`${COOKIE}=tok123`);
		expect(JSON.parse(run?.body ?? '')).toEqual({params: {parent: 'project:inbox'}});
		expect(out).toBe(
			'In Inbox\ntask:inbox1:a1  Buy milk\ntask:inbox1:a2  (untitled)\nMore: add "page": "50" to the params\n',
		);
	});

	test('a record prints a field a line, a longer value indented under its name', async () => {
		expect(
			await proxyCli(
				'run',
				'conn-tt',
				'tasks_update',
				'--params',
				'{"id":"task:inbox1:a1","title":"Buy oat milk"}',
			),
		).toBe(0);
		expect(out).toBe('id: task:inbox1:a1\ntitle: Buy oat milk\nnotes:\n    Two\n    cartons\n');
	});

	test('a refusal exits 1 with what the server said, as JSON with --json', async () => {
		expect(
			await proxyCli('run', 'conn-tt', 'tasks_complete', '--params', '{"id":"task:inbox1:a1"}'),
		).toBe(1);
		expect(err).toContain('This login may not do that');

		expect(
			await proxyCli('run', 'conn-tt', 'tasks_create', '--params', '{"colour":"red"}', '--json'),
		).toBe(1);
		expect(JSON.parse(err)).toEqual({
			error: 'tasks_create takes no colour; it takes parent, title, priority, content',
		});
	});

	test('the server turning the origin down says to log in at its APP_URL', async () => {
		server = () => Response.json({error: 'forbidden_origin'}, {status: 403});
		expect(await proxyCli('run', 'conn-tt', 'tasks_list')).toBe(1);
		expect(err).toContain('APP_URL');
	});

	test('logout ends the session on the server and forgets it here', async () => {
		expect(await proxyCli('logout')).toBe(0);
		expect(sent[0]?.url).toBe(`${ORIGIN}/agent-auth/logout`);
		expect(sent[0]?.headers.get('origin')).toBe(ORIGIN);
		expect((await readSession(dir)).unwrap()).toBeNull();
		expect(await proxyCli('connections')).toBe(1);
		expect(err).toContain('Not signed in');
	});
});

test('an ended session asks for a new login without sending anything', async () => {
	(await writeSession(dir, {...session, expires: '2026-10-01T00:00:00.000Z'})).unwrap();
	expect(await proxyCli('connections')).toBe(1);
	expect(err).toContain('run proxy login again');
	expect(sent).toHaveLength(0);
});
