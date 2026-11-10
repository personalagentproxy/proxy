import {afterAll, beforeEach, describe, expect, mock, test} from 'bun:test';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';

import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import * as realAgent from '@proxy/db/agent';
import * as realOrganization from '@proxy/db/organization';
import * as realSandbox from '@proxy/db/sandbox';

import * as realTasks from '../agent-side/tasks';
import {signCliToken} from './token';

// The whole app, as the api serves it, with the database's answers made here: so the routes are
// reached through every guard the router mounts, and none it shouldn't.

const SECRET = 'test-auth-secret';
const APP_URL = 'https://app.example.com';

mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL, AUTH_SECRET: SECRET}}));

// Read once the environment is mocked: they read it as they load, and the real one needs a database's address.
const realTools = await import('../agent-side/tools');
const realTarget = await import('../records/target');

const getSignedInAgentById = mock();

mock.module('@proxy/db/agent', () => ({...realAgent, getSignedInAgentById}));
const getMembership = mock();
mock.module('@proxy/db/organization', () => ({...realOrganization, getMembership}));

const getSandbox = mock();
const getHoldingTask = mock();

mock.module('@proxy/db/sandbox', () => ({...realSandbox, getSandbox, getHoldingTask}));

const requireOpenTask = mock();

mock.module('../agent-side/tasks', () => ({...realTasks, requireOpenTask}));

const listAgentConnections = mock();
const listAgentTools = mock();
const runAgentTool = mock();

mock.module('../agent-side/tools', () => ({...realTools, listAgentConnections, listAgentTools, runAgentTool}));

const loadConnection = mock();

mock.module('../records/target', () => ({...realTarget, loadConnection}));

mock.module('../observability/log', () => ({
	log: {debug: mock(), info: mock(), warn: mock(), error: mock()},
	serializeError: mock(() => ({})),
}));

const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'claude', name: 'Claude', orgSlug: 'org-1', experiments: []};
const mailbox = {id: 'mail-1', integrationId: 'email', account: 'alex@example.com', shared: false, actions: ['read'], tools: null, name: null};
const sandboxes = {id: 'sandboxes-1', integrationId: 'sandbox', account: 'Alex’s Workspace', shared: false, actions: ['read', 'run'], tools: [], name: null};
const sandbox = {
	id: 'sandbox-1',
	orgId: 'org-1',
	connectionId: 'sandboxes-1',
	name: 'scratch',
	state: 'running',
	backendId: 'temp-dir',
	backendRef: 'ref-1',
	heldByTaskId: 'task-1',
	heldAt: new Date(),
	lastUsedAt: new Date(),
	createdAt: new Date(),
};

// A task as the sandbox's lease reads it, under way, with its parent.
function holdingTask(id: string, parentId: string | null = null) {
	return {id, parentId, title: `Task ${id}`, lastActiveAt: new Date(), finishedAt: null};
}

function token(taskId = 'task-1', ownerUserId: string | null = 'user-1'): string {
	return signCliToken({agentId: 'agent-1', orgId: 'org-1', ownerUserId, taskId, sandboxId: 'sandbox-1', connectionId: 'sandboxes-1', expiresAt: Math.floor(Date.now() / 1000) + 120}, SECRET);
}

const servers: Server[] = [];

async function start(): Promise<string> {
	const {createHttpApp} = await import('../server/create-http-app');
	const server = createHttpApp({webDist: '/nonexistent'}).listen(0);
	servers.push(server);
	return `http://localhost:${(server.address() as AddressInfo).port}`;
}

let base = '';

async function call(body: object | string, headers: Record<string, string> = {authorization: `Bearer ${token()}`}) {
	const res = await fetch(`${base}/api/cli/call`, {
		method: 'POST',
		headers: {'content-type': 'application/json', ...headers},
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
	return {status: res.status, body: (await res.json()) as {result?: object; error?: string; message?: string}};
}

beforeEach(async () => {
	mock.clearAllMocks();
	base ||= await start();
	getSignedInAgentById.mockResolvedValue(Ok(signedIn));
	getMembership.mockResolvedValue(Ok({role: 'member'}));
	requireOpenTask.mockResolvedValue(Ok({id: 'task-1'}));
	getSandbox.mockResolvedValue(Ok(sandbox));
	getHoldingTask.mockImplementation(async (_orgId: string, id: string) => Ok(holdingTask(id)));
	listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'}, connections: [mailbox, sandboxes]}));
	listAgentTools.mockResolvedValue(Ok([]));
	runAgentTool.mockResolvedValue(Ok({records: [], nextCursor: null}));
	loadConnection.mockImplementation(async (_viewer: object, id: string) => Ok({connection: {id}, integration: {id: id === 'sandboxes-1' ? 'sandbox' : 'email'}}));
});

afterAll(() => {
	for (const server of servers) {
		server.close();
	}
});

describe('the token', () => {
	test('none, or one that is not valid, is a 401 saying what to do', async () => {
		const none = await call({method: 'connections'}, {});
		const bad = await call({method: 'connections'}, {authorization: 'Bearer pap_nonsense.nonsense'});
		const other = await call(
			{method: 'connections'},
			{
				authorization: `Bearer ${signCliToken({agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', taskId: 'task-1', sandboxId: 'sandbox-1', connectionId: 'sandboxes-1', expiresAt: Math.floor(Date.now() / 1000) + 120}, 'another-secret')}`,
			},
		);

		expect(none).toEqual({status: 401, body: {error: 'unauthenticated', message: expect.stringContaining('Authorization: Bearer $PAP_TOKEN')}});
		expect(bad).toEqual({status: 401, body: {error: 'unauthenticated', message: expect.stringContaining('not a valid token')}});
		expect(other.status).toBe(401);
		expect(listAgentConnections).not.toHaveBeenCalled();
	});

	test('one expired is a 401 saying to run the command again', async () => {
		const expired = signCliToken(
			{agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', taskId: 'task-1', sandboxId: 'sandbox-1', connectionId: 'sandboxes-1', expiresAt: Math.floor(Date.now() / 1000) - 1},
			SECRET,
		);
		const res = await call({method: 'connections'}, {authorization: `Bearer ${expired}`});

		expect(res.status).toBe(401);
		expect(res.body.message).toContain('expired');
		expect(res.body.message).toContain('pap: true');
	});

	test('for an agent revoked since, a 401', async () => {
		getSignedInAgentById.mockResolvedValue(Ok(null));
		const res = await call({method: 'connections'});

		expect(res.status).toBe(401);
		expect(getSignedInAgentById).toHaveBeenCalledWith('org-1', 'agent-1');
		expect(listAgentConnections).not.toHaveBeenCalled();
	});

	test('for a task finished since, or gone, a 401', async () => {
		requireOpenTask.mockResolvedValueOnce(Err(ApiErr.conflict('Task task-1 (Triage inbox) is finished.')));
		const finished = await call({method: 'connections'});
		requireOpenTask.mockResolvedValueOnce(Err(ApiErr.notFound('task', 'task-1')));
		const gone = await call({method: 'connections'});

		expect(finished.status).toBe(401);
		expect(finished.body.message).toContain('has ended');
		expect(gone.status).toBe(401);
		expect(requireOpenTask).toHaveBeenCalledWith(signedIn, 'task-1');
	});

	test('the database failing is the server failing, not the token', async () => {
		requireOpenTask.mockResolvedValue(Err(ApiErr.dbError(new Error('down'))));
		const res = await call({method: 'connections'});

		expect(res.status).toBe(500);
	});

	test('for a sandbox now held by another task, or gone, a 401 naming no task', async () => {
		getSandbox.mockResolvedValueOnce(Ok({...sandbox, heldByTaskId: 'task-9'}));
		const taken = await call({method: 'connections'});
		getSandbox.mockResolvedValueOnce(Ok(null));
		const gone = await call({method: 'connections'});

		expect(taken.status).toBe(401);
		expect(taken.body.message).not.toContain('task-9');
		expect(gone.status).toBe(401);
		expect(getSandbox).toHaveBeenCalledWith('sandboxes-1', 'sandbox-1');
	});

	test('a sub-task of the task holding the sandbox works on it as that task does', async () => {
		getHoldingTask.mockImplementation(async (_orgId: string, id: string) => Ok(holdingTask(id, id === 'task-2' ? 'task-1' : null)));
		const res = await call({method: 'connections'}, {authorization: `Bearer ${token('task-2')}`});

		expect(res.status).toBe(200);
		expect(requireOpenTask).toHaveBeenCalledWith(signedIn, 'task-2');
	});

	test('a browser’s Origin other than the app’s is no matter: the token is the guard', async () => {
		const res = await call({method: 'connections'}, {authorization: `Bearer ${token()}`, origin: 'https://elsewhere.example.com'});

		expect(res.status).toBe(200);
	});
});

describe('POST /api/cli/call', () => {
	test('connections leaves out the Sandboxes connections', async () => {
		const res = await call({method: 'connections'});

		expect(res.status).toBe(200);
		expect(res.body.result).toEqual([{connection: 'mail-1', integration: 'Email', account: 'alex@example.com', shared: false, can: 'Read'}]);
	});

	test('call goes through the gate, as the token’s agent for its task, in by the CLI', async () => {
		const res = await call({method: 'call', args: ['mail-1', 'emails_list', {search: 'invoice'}]});

		expect(res).toEqual({status: 200, body: {result: {records: [], nextCursor: null}}});
		expect(runAgentTool).toHaveBeenCalledWith({agent: signedIn, via: 'cli', taskId: 'task-1'}, 'mail-1', 'emails_list', {search: 'invoice'});
	});

	test('a shared agent, as the built-in one, acts for the member it ran the command for, while they are one', async () => {
		getSignedInAgentById.mockResolvedValue(Ok({...signedIn, ownerUserId: null}));

		const res = await call({method: 'call', args: ['mail-1', 'emails_list', {}]});
		expect(res.status).toBe(200);
		expect(getMembership).toHaveBeenCalledWith('user-1', 'org-1');
		expect(runAgentTool).toHaveBeenCalledWith({agent: signedIn, via: 'cli', taskId: 'task-1'}, 'mail-1', 'emails_list', {});
		expect(requireOpenTask).toHaveBeenCalledWith(signedIn, 'task-1');

		getMembership.mockResolvedValue(Ok(null));
		const gone = await call({method: 'connections'});
		expect(gone.status).toBe(401);
		expect(gone.body.message).toBe('The member PAP_TOKEN acts for is no longer in the organization, so it can do nothing more.');
	});

	test('a shared agent acting for no one stays so; an agent of another member’s own is refused', async () => {
		getSignedInAgentById.mockResolvedValue(Ok({...signedIn, ownerUserId: null}));
		await call({method: 'connections'}, {authorization: `Bearer ${token('task-1', null)}`});
		expect(listAgentConnections).toHaveBeenCalledWith({...signedIn, ownerUserId: null});
		expect(getMembership).not.toHaveBeenCalled();

		getSignedInAgentById.mockResolvedValue(Ok({...signedIn, ownerUserId: 'user-2'}));
		expect((await call({method: 'connections'})).status).toBe(401);
	});

	test('tools lists a connection’s tools', async () => {
		const res = await call({method: 'tools', args: ['mail-1']});

		expect(res).toEqual({status: 200, body: {result: []}});
		expect(listAgentTools).toHaveBeenCalledWith(signedIn, 'mail-1');
	});

	test('a Sandboxes connection’s tools are refused from inside a sandbox', async () => {
		const tools = await call({method: 'tools', args: ['sandboxes-1']});
		const run = await call({method: 'call', args: ['sandboxes-1', 'sandbox_exec', {sandbox: 'sandbox-1', command: 'ls'}]});

		expect(tools).toEqual({status: 422, body: {error: 'validation_error', message: expect.stringContaining('from inside a sandbox')}});
		expect(run.status).toBe(422);
		expect(run.body.message).toStartWith('sandbox_exec on sandboxes-1: Sandboxes can’t be used from inside a sandbox');
		expect(listAgentTools).not.toHaveBeenCalled();
		expect(runAgentTool).not.toHaveBeenCalled();
	});

	test('a tool refused is a failed call, with the words a script would get', async () => {
		runAgentTool.mockResolvedValue(Err(ApiErr.forbidden()));
		const res = await call({method: 'call', args: ['mail-1', 'emails_send', {}]});

		expect(res).toEqual({status: 422, body: {error: 'forbidden', message: 'emails_send on mail-1: Not allowed: emails_send. The person who made this login can allow it.'}});
	});

	test('what to run instead is named as the CLI’s commands, not a script’s functions', async () => {
		runAgentTool.mockResolvedValueOnce(Err(ApiErr.notFound('connection', 'nope')));
		runAgentTool.mockResolvedValueOnce(Err(ApiErr.notFound('tool', 'emails_nope')));
		const connection = await call({method: 'call', args: ['nope', 'emails_list', {}]});
		const tool = await call({method: 'call', args: ['mail-1', 'emails_nope', {}]});
		const usage = await call({method: 'tools', args: []});

		expect(connection.body.message).toBe('emails_list on nope: No connection nope; see `pap connections`.');
		expect(tool.body.message).toBe('emails_nope on mail-1: No tool emails_nope; see `pap tools <connection>`.');
		expect(usage.body.message).toStartWith('Takes `pap tools <connection>`:');
	});

	test('the token’s task is the one used: starting and finishing one are refused', async () => {
		const start = await call({method: 'startTask', args: [{title: 'Other', goal: 'Something else'}]});
		const finish = await call({method: 'finishTask', args: []});

		expect(start).toEqual({status: 422, body: {error: 'validation_error', message: 'Your task is kept for you.'}});
		expect(finish.status).toBe(422);
	});

	test('a method it doesn’t know, arguments that aren’t right, or a body that isn’t JSON is a failed call', async () => {
		const unknown = await call({method: 'delete', args: []});
		const wrong = await call({method: 'tools', args: []});
		const notJson = await call('{method');

		expect(unknown.status).toBe(422);
		expect(unknown.body.message).toContain('Takes {method, args}');
		expect(wrong).toEqual({status: 422, body: {error: 'validation_error', message: expect.stringContaining('`pap tools <connection>`')}});
		expect(notJson).toEqual({status: 422, body: {error: 'parse_error', message: expect.stringContaining('not JSON')}});
	});
});
