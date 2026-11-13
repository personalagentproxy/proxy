import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {AlertRow} from '@proxy/db/alerts';
import type {ThreadRow} from '@proxy/db/harness';
import {findCollection, findIntegration} from '@proxy/integrations';

import {type FakeStore, fakeStore} from './fake-store';

// The catalog's modules read the api's env as they load, and ci has no .env: so the env is mocked,
// and the modules imported after, since a static import would load before the mock. The MCP
// dispatch is mocked beside the real tool list, as tool-job's tests mock it, so a call run inline
// goes to it and nowhere else.
mock.module('../utils/env', () => ({env: {NODE_ENV: 'test', APP_URL: 'http://localhost:5173'}}));
const callMcpTool = mock();
const mcpTools = await import('../mcp/tools');
mock.module('../mcp/tools', () => ({...mcpTools, callMcpTool}));
const listAgentConnections = mock();
mock.module('../agent-side/tools', () => ({listAgentConnections}));
mock.module('../records/connectors', () => ({connectorFor: () => ({list: mock(), get: mock(), changes: mock()})}));
const {isGateTool, THREAD_TOOLS, toolSurfaceFor} = await import('./tool-surface');
const EMAILS_READ = findCollection(findIntegration('google') ?? {collections: []}, 'emails')?.read ?? '';

type Params = {properties: Record<string, unknown>; required: string[]};

function tool(name: string) {
	const found = THREAD_TOOLS.find((candidate) => candidate.name === name);
	if (!found) {
		throw new Error(`No thread tool ${name}`);
	}
	return {...found, parameters: found.parameters as Params};
}

describe('a thread’s tools', () => {
	test('are the MCP server’s script, a message to the person, a sleep, setting an alert and cancelling one, and starting another thread', () => {
		expect(THREAD_TOOLS.map((candidate) => candidate.name)).toEqual(['script', 'send_to_person', 'sleep_until', 'set_alert', 'cancel_alert', 'start_thread']);
		expect(tool('start_thread').parameters.required).toEqual(['text']);
		expect(tool('send_to_person').parameters.required).toEqual(['text']);
		expect(tool('send_to_person').description).toContain('Tells the person something while you go on');
		expect(tool('set_alert').parameters.required).toEqual(['title', 'brief']);
		expect(tool('cancel_alert').parameters.required).toEqual(['id']);
	});

	test('the script takes no task, and starts and finishes none: the loop keeps its task', () => {
		expect(tool('script').parameters.properties).not.toHaveProperty('task');
		expect(tool('script').parameters.required).toEqual(['code']);
		expect(tool('script').description).toContain('pap.call(connection, tool, params?)');
		expect(tool('script').description).not.toContain('pap.startTask');
		expect(tool('script').description).not.toContain('pap.finishTask');
	});

	test('the gate’s one tool is the script', () => {
		expect(isGateTool('script')).toBe(true);
		expect(isGateTool('read')).toBe(false);
		expect(isGateTool('sleep_until')).toBe(false);
		expect(isGateTool('send_to_person')).toBe(false);
	});
});

describe('running a call inline', () => {
	const now = new Date('2026-10-21T10:00:00Z');
	const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: []};
	// A thread of the member's chat, which their message opened, with the inference job running its turn.
	const thread: ThreadRow = {
		id: 'thread-1',
		orgId: 'org-1',
		agentId: 'agent-1',
		personaId: 'persona-1',
		userId: 'user-1',
		parentThreadId: 'chat-1',
		title: 'Pricing review with Dana',
		taskId: 'task-1',
		harness: null,
		harnessSession: null,
		createdAt: now,
	};
	const job = {jobId: 'job-1', workerId: 'w1', threadId: 'thread-1'};
	const alert: AlertRow = {
		id: 'alert-1',
		orgId: 'org-1',
		userId: 'user-1',
		threadId: 'thread-1',
		title: 'Call Dana',
		brief: 'Remind them.',
		at: new Date('2026-10-22T07:30:00Z'),
		collectionId: null,
		connectionIds: [],
		terms: [],
		lastMatchedAt: null,
		createdAt: now,
	};
	const watchable = {id: 'conn-a', integrationId: 'google', account: 'a@example.com', shared: true, actions: [EMAILS_READ], tools: null, name: null};

	let store: FakeStore;
	const surface = () => toolSurfaceFor(store, thread, {id: 'job-1'}, 'w1', () => now);
	const run = (name: string, args: string, id = 'c1') => surface().execute({id, name, arguments: args});

	beforeEach(() => {
		mock.clearAllMocks();
		store = fakeStore();
		store.getThreadAgent.mockResolvedValue(Ok(signedIn));
		store.getAgentTask.mockResolvedValue(
			Ok({
				id: 'task-1',
				agentId: 'agent-1',
				personaId: 'persona-1',
				parentId: null,
				title: 'Pricing review with Dana',
				goal: 'Find the pricing review with Dana.',
				via: 'harness',
				createdAt: now,
				finishedAt: null,
				outcome: null,
				lastActiveAt: new Date(),
			}),
		);
		store.scheduleWake.mockResolvedValue(Ok(true));
		store.setAlertInline.mockResolvedValue(Ok(alert));
		store.deleteAlert.mockResolvedValue(Ok(true));
		callMcpTool.mockResolvedValue({content: [{type: 'text', text: '{"records":[]}'}], structuredContent: {records: []}});
		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'proxy', name: 'Finance'}, connections: [watchable]}));
	});

	test('gives the harness the thread’s tools', () => {
		expect(surface().tools.map((candidate) => candidate.name)).toEqual(['script', 'send_to_person', 'sleep_until', 'set_alert', 'cancel_alert', 'start_thread']);
		expect(surface().tools.every((candidate) => !candidate.readOnly)).toBe(true);
	});

	test('start_thread opens a thread in the member’s chat, opened by what it is to work on as an event naming this thread, and answers with its page', async () => {
		const started: ThreadRow = {...thread, id: 'thread-2', title: 'Book a table for four on Friday', taskId: 'task-2'};
		store.startThread.mockResolvedValue(Ok(started));
		store.getOrgSlug.mockResolvedValue(Ok('acme'));

		const answer = (await run('start_thread', JSON.stringify({text: 'Book a table for four on Friday'}))).unwrap();

		expect(answer).toEqual({
			text: 'Started the thread “Book a table for four on Friday”: http://localhost:5173/acme/chat/persona-1/threads/thread-2. Its agent works on it from there; nothing of it comes back here.',
			isError: false,
		});
		expect(store.startThread).toHaveBeenCalledWith(
			'thread-1',
			'Started for the person from the thread “Pricing review with Dana”: Book a table for four on Friday',
			expect.objectContaining({
				title: 'Book a table for four on Friday',
				task: expect.objectContaining({goal: 'Book a table for four on Friday', personaId: 'persona-1', ownerUserId: 'user-1', parentId: null}),
			}),
		);
	});

	test('start_thread without text, or from no thread of a chat, starts nothing and says why', async () => {
		expect((await run('start_thread', JSON.stringify({text: '  '}))).unwrap()).toEqual({text: 'Give text, what the new thread is to work on.', isError: true});
		expect(store.startThread).not.toHaveBeenCalled();

		store.startThread.mockResolvedValue(Ok(null));
		expect((await run('start_thread', JSON.stringify({text: 'Book a table'}))).unwrap()).toEqual({text: 'This is not a thread of a chat, so no thread can be started from it.', isError: true});
		expect(store.getOrgSlug).not.toHaveBeenCalled();
	});

	test('a script goes through the MCP dispatch as the agent acting as the member, for the thread’s task, a refusal answered as an error, and a long result cut', async () => {
		const code = 'return pap.call("mail-1", "emails_list")';
		expect((await run('script', JSON.stringify({code}))).unwrap()).toEqual({text: '{"records":[]}', isError: false});
		expect(callMcpTool).toHaveBeenCalledWith(signedIn, {code, task: 'task-1'}, 'harness');

		callMcpTool.mockResolvedValue({content: [{type: 'text', text: 'This login may not run emails_send.'}], isError: true});
		expect((await run('script', JSON.stringify({code: 'return pap.call("mail-1", "emails_send")'}))).unwrap()).toEqual({text: 'This login may not run emails_send.', isError: true});

		callMcpTool.mockResolvedValue({content: [{type: 'text', text: 'x'.repeat(70_000)}]});
		const long = (await run('script', JSON.stringify({code}))).unwrap();
		expect(long.text.length).toBeLessThan(61_000);
		expect(long.text).toEndWith('[Cut: the result was 70000 characters long.]');
	});

	test('a tool the thread hasn’t got, and arguments that aren’t a JSON object, are answered as errors, and nothing is run', async () => {
		expect((await run('read', '{}')).unwrap()).toEqual({text: 'There is no tool read.', isError: true});
		expect((await run('fly', '{"to":"Lisbon"}')).unwrap()).toEqual({text: 'There is no tool fly.', isError: true});
		expect((await run('script', 'not json')).unwrap()).toEqual({text: 'The arguments were not a JSON object.', isError: true});
		expect((await run('sleep_until', '[1]')).unwrap()).toEqual({text: 'The arguments were not a JSON object.', isError: true});
		expect(callMcpTool).not.toHaveBeenCalled();
		expect(store.scheduleWake).not.toHaveBeenCalled();
	});

	test('a sleep has the thread woken at the time, and its answer ends the turn; without a time it is refused', async () => {
		expect((await run('sleep_until', '{"seconds":60}')).unwrap()).toEqual({
			text: 'Sleeping until 2026-10-21T10:01:00.000Z. You will be woken then, or earlier by a message.',
			isError: false,
			endTurn: true,
		});
		expect(store.scheduleWake).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', new Date('2026-10-21T10:01:00Z'));

		expect((await run('sleep_until', '{}')).unwrap()).toEqual({text: 'Give until, a time in ISO 8601, or seconds from now.', isError: true});
		expect(store.scheduleWake).toHaveBeenCalledTimes(1);

		store.scheduleWake.mockResolvedValue(Ok(false));
		expect((await run('sleep_until', '{"seconds":60}')).unwrapErr().kind).toBe('conflict');
	});

	test('a sleep is counted from when the call is made, not from when the turn began', async () => {
		// The turn began at ten; the model asks for a minute's sleep three minutes into it.
		let time = now;
		const late = toolSurfaceFor(store, thread, {id: 'job-1'}, 'w1', () => time);
		time = new Date('2026-10-21T10:03:00Z');

		expect((await late.execute({id: 'c1', name: 'sleep_until', arguments: '{"seconds":60}'})).unwrap()).toMatchObject({text: expect.stringContaining('Sleeping until 2026-10-21T10:04:00.000Z')});
		expect(store.scheduleWake).toHaveBeenCalledWith('job-1', 'w1', 'thread-1', new Date('2026-10-21T10:04:00Z'));
	});

	test('a message to the person is answered at once, nothing written for it: the call is what the person reads', async () => {
		expect((await run('send_to_person', '{"text":"Halfway through the invoices."}')).unwrap()).toEqual({text: 'Sent.', isError: false});
		expect((await run('send_to_person', '{}')).unwrap()).toEqual({text: 'Give text, the message.', isError: true});
		expect(store.appendTurnEntries).not.toHaveBeenCalled();
	});

	test('set_alert sets the alert on its own, fenced by the job, a watch on the connections the agent may read with the collection, and answers with it; cancel_alert deletes one', async () => {
		expect((await run('set_alert', '{"title":"Call Dana","brief":"Remind them.","at":"2026-10-22T07:30:00Z"}')).unwrap()).toEqual({
			text: 'Set the alert alert-1: “Call Dana”, due 2026-10-22T07:30:00.000Z.',
			isError: false,
		});
		expect(store.setAlertInline).toHaveBeenCalledWith(job, {kind: 'time', title: 'Call Dana', brief: 'Remind them.', at: new Date('2026-10-22T07:30:00Z')});

		await run('set_alert', '{"title":"Bank","brief":"Tell me.","collection":"emails","terms":["Loan"]}');
		expect(store.setAlertInline).toHaveBeenLastCalledWith(job, {kind: 'watch', title: 'Bank', brief: 'Tell me.', collectionId: 'emails', connectionIds: ['conn-a'], terms: ['loan']});

		expect((await run('set_alert', '{"title":"Bank","brief":"Tell me.","collection":"emails","connections":["conn-b"]}')).unwrap()).toEqual({
			text: 'You may not watch conn-b for emails. The connections you may watch for it: conn-a (Google (a@example.com)).',
			isError: true,
		});
		expect((await run('set_alert', '{"title":"Bank","brief":"Tell me."}')).unwrap()).toEqual({
			text: 'Give at, for one message at that time, or collection, for a watch: one of the two.',
			isError: true,
		});
		expect(store.setAlertInline).toHaveBeenCalledTimes(2);

		store.setAlertInline.mockResolvedValue(Ok(null));
		expect((await run('set_alert', '{"title":"Call Dana","brief":"Remind them.","at":"2026-10-22T07:30:00Z"}')).unwrapErr().kind).toBe('conflict');

		expect((await run('cancel_alert', '{"id":"alert-1"}')).unwrap()).toEqual({text: 'Cancelled the alert alert-1.', isError: false});
		expect(store.deleteAlert).toHaveBeenCalledWith('alert-1', {orgId: 'org-1', userId: 'user-1'});
		store.deleteAlert.mockResolvedValue(Ok(false));
		expect((await run('cancel_alert', '{"id":"alert-2"}')).unwrap()).toEqual({
			text: 'No alert alert-2.',
			isError: true,
		});
	});

	test('never writes to the log, nor ends the job: the result is the worker’s to write', async () => {
		await run('script', '{"code":"return 1"}');
		await run('sleep_until', '{"seconds":60}');
		await run('send_to_person', '{"text":"Hi"}');
		await run('set_alert', '{"title":"Call Dana","brief":"Remind them.","at":"2026-10-22T07:30:00Z"}');
		expect(store.appendTurnEntries).not.toHaveBeenCalled();
		expect(store.completeToolJob).not.toHaveBeenCalled();
		expect(store.completeSetAlert).not.toHaveBeenCalled();
		expect(store.completeInference).not.toHaveBeenCalled();
		expect(store.finishJob).not.toHaveBeenCalled();
	});
});
