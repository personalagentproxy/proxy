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
const {isGateTool, MAIN_AGENT_TOOLS, SUB_AGENT_TOOLS, THREAD_TOOLS, toolsFor, toolSurfaceFor} = await import('./tool-surface');
const EMAILS_READ = findCollection(findIntegration('google') ?? {collections: []}, 'emails')?.read ?? '';

type Params = {properties: Record<string, unknown>; required: string[]};

function tool(name: string) {
	const found = SUB_AGENT_TOOLS.find((candidate) => candidate.name === name);
	if (!found) {
		throw new Error(`No sub-agent tool ${name}`);
	}
	return {...found, parameters: found.parameters as Params};
}

describe('the main agent’s tools', () => {
	test('are four: starting a sub-agent, with a title and a brief, sending one a message, by id, setting an alert and cancelling one', () => {
		expect(MAIN_AGENT_TOOLS.map((candidate) => candidate.name)).toEqual(['create_subagent', 'send_to_subagent', 'set_alert', 'cancel_alert']);
		expect((MAIN_AGENT_TOOLS[0]?.parameters as Params).required).toEqual(['title', 'brief']);
		expect((MAIN_AGENT_TOOLS[1]?.parameters as Params).required).toEqual(['subagent', 'text']);
		expect((MAIN_AGENT_TOOLS[2]?.parameters as Params).required).toEqual(['title', 'brief']);
		expect((MAIN_AGENT_TOOLS[3]?.parameters as Params).required).toEqual(['id']);
	});

	test('are the conversation’s, and a sub-agent and a chat’s thread get their own', () => {
		expect(toolsFor({parentThreadId: null, parentCallId: null})).toBe(MAIN_AGENT_TOOLS);
		expect(toolsFor({parentThreadId: 'thread-1', parentCallId: 'c0'})).toBe(SUB_AGENT_TOOLS);
		expect(toolsFor({parentThreadId: 'thread-1', parentCallId: null})).toBe(THREAD_TOOLS);
	});
});

describe('a chat thread’s tools', () => {
	test('are the MCP server’s script, a message to the person, a sleep, and setting an alert and cancelling one: no sub-agents, and no parent to tell', () => {
		expect(THREAD_TOOLS.map((candidate) => candidate.name)).toEqual(['script', 'send_to_person', 'sleep_until', 'set_alert', 'cancel_alert']);
		const toPerson = THREAD_TOOLS.find((candidate) => candidate.name === 'send_to_person');
		expect((toPerson?.parameters as Params).required).toEqual(['text']);
		expect(toPerson?.description).toContain('Tells the person something while you go on');
	});
});

describe('a sub-agent’s tools', () => {
	test('are the MCP server’s script, a message to the agent it works for, and a sleep', () => {
		expect(SUB_AGENT_TOOLS.map((candidate) => candidate.name)).toEqual(['script', 'send_to_parent', 'sleep_until']);
		expect(tool('send_to_parent').parameters.required).toEqual(['text']);
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
		expect(isGateTool('send_to_parent')).toBe(false);
		expect(isGateTool('create_subagent')).toBe(false);
	});
});

describe('running a call inline', () => {
	const now = new Date('2026-10-21T10:00:00Z');
	const signedIn = {agentId: 'agent-1', orgId: 'org-1', ownerUserId: 'user-1', providerId: 'proxy', name: 'Finance', orgSlug: 'acme', experiments: []};
	// The member's conversation, and a sub-agent started from it, each with the inference job running its turn.
	const conversation: ThreadRow = {
		id: 'thread-0',
		orgId: 'org-1',
		agentId: 'agent-1',
		personaId: 'persona-1',
		userId: 'user-1',
		parentThreadId: null,
		parentCallId: null,
		title: null,
		taskId: null,
		harness: null,
		harnessSession: null,
		createdAt: now,
	};
	const sub: ThreadRow = {...conversation, id: 'thread-1', parentThreadId: 'thread-0', parentCallId: 'c0', title: 'Find the invoices', taskId: 'task-1'};
	// A thread of the member's chat, which their message opened.
	const opened: ThreadRow = {...conversation, id: 'thread-2', parentThreadId: 'thread-0', title: 'Pricing review with Dana', taskId: 'task-1'};
	const mainJob = {jobId: 'job-1', workerId: 'w1', threadId: 'thread-0'};
	const subJob = {jobId: 'job-2', workerId: 'w1', threadId: 'thread-1'};
	const threadJob = {jobId: 'job-3', workerId: 'w1', threadId: 'thread-2'};
	const alert: AlertRow = {
		id: 'alert-1',
		orgId: 'org-1',
		userId: 'user-1',
		threadId: 'thread-0',
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
	const onMain = () => toolSurfaceFor(store, conversation, {id: 'job-1'}, 'w1', () => now);
	const onSub = () => toolSurfaceFor(store, sub, {id: 'job-2'}, 'w1', () => now);
	const onThread = () => toolSurfaceFor(store, opened, {id: 'job-3'}, 'w1', () => now);
	const run = (surface: ReturnType<typeof onMain>, name: string, args: string, id = 'c1') => surface.execute({id, name, arguments: args});

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
				title: 'Find the invoices',
				goal: 'Search the mailbox.',
				via: 'harness',
				createdAt: now,
				finishedAt: null,
				outcome: null,
				lastActiveAt: new Date(),
			}),
		);
		store.scheduleWake.mockResolvedValue(Ok(true));
		store.tellParentInline.mockResolvedValue(Ok(true));
		store.startSubAgentInline.mockResolvedValue(Ok('thread-9'));
		store.messageSubAgentInline.mockResolvedValue(Ok({subAgent: {...sub, state: {kind: 'asleep', until: new Date('2026-10-21T11:00:00Z')}}}));
		store.setAlertInline.mockResolvedValue(Ok(alert));
		store.deleteAlert.mockResolvedValue(Ok(true));
		callMcpTool.mockResolvedValue({content: [{type: 'text', text: '{"records":[]}'}], structuredContent: {records: []}});
		listAgentConnections.mockResolvedValue(Ok({agent: {id: 'agent-1', providerId: 'proxy', name: 'Finance'}, connections: [watchable]}));
	});

	test('a script goes through the MCP dispatch as the sub-agent acting as the member, for its task, a refusal answered as an error, and a long result cut', async () => {
		const code = 'return pap.call("mail-1", "emails_list")';
		expect((await run(onSub(), 'script', JSON.stringify({code}))).unwrap()).toEqual({text: '{"records":[]}', isError: false});
		expect(callMcpTool).toHaveBeenCalledWith(signedIn, {code, task: 'task-1'}, 'harness');

		callMcpTool.mockResolvedValue({content: [{type: 'text', text: 'This login may not run emails_send.'}], isError: true});
		expect((await run(onSub(), 'script', JSON.stringify({code: 'return pap.call("mail-1", "emails_send")'}))).unwrap()).toEqual({text: 'This login may not run emails_send.', isError: true});

		callMcpTool.mockResolvedValue({content: [{type: 'text', text: 'x'.repeat(70_000)}]});
		const long = (await run(onSub(), 'script', JSON.stringify({code}))).unwrap();
		expect(long.text.length).toBeLessThan(61_000);
		expect(long.text).toEndWith('[Cut: the result was 70000 characters long.]');
	});

	test('a tool the thread’s agent hasn’t got, and arguments that aren’t a JSON object, are answered as errors, and nothing is run', async () => {
		expect((await run(onMain(), 'script', '{"code":"return 1"}')).unwrap()).toEqual({text: 'There is no tool script.', isError: true});
		expect((await run(onSub(), 'read', '{}')).unwrap()).toEqual({text: 'There is no tool read.', isError: true});
		expect((await run(onSub(), 'create_subagent', '{"title":"a","brief":"b"}')).unwrap()).toEqual({text: 'There is no tool create_subagent.', isError: true});
		expect((await run(onSub(), 'set_alert', '{}')).unwrap()).toEqual({text: 'There is no tool set_alert.', isError: true});
		expect((await run(onMain(), 'sleep_until', '{"seconds":5}')).unwrap()).toEqual({text: 'There is no tool sleep_until.', isError: true});
		expect((await run(onSub(), 'fly', '{}')).unwrap()).toEqual({text: 'There is no tool fly.', isError: true});
		expect((await run(onSub(), 'script', 'not json')).unwrap()).toEqual({text: 'The arguments were not a JSON object.', isError: true});
		expect((await run(onMain(), 'create_subagent', '[1]')).unwrap()).toEqual({text: 'The arguments were not a JSON object.', isError: true});
		expect(callMcpTool).not.toHaveBeenCalled();
		expect(store.startSubAgentInline).not.toHaveBeenCalled();
		expect(store.scheduleWake).not.toHaveBeenCalled();
	});

	test('a sleep has the thread woken at the time, and its answer ends the turn; without a time it is refused', async () => {
		expect((await run(onSub(), 'sleep_until', '{"seconds":60}')).unwrap()).toEqual({
			text: 'Sleeping until 2026-10-21T10:01:00.000Z. You will be woken then, or earlier by a message.',
			isError: false,
			endTurn: true,
		});
		expect(store.scheduleWake).toHaveBeenCalledWith('job-2', 'w1', 'thread-1', new Date('2026-10-21T10:01:00Z'));

		expect((await run(onSub(), 'sleep_until', '{}')).unwrap()).toEqual({text: 'Give until, a time in ISO 8601, or seconds from now.', isError: true});
		expect(store.scheduleWake).toHaveBeenCalledTimes(1);

		store.scheduleWake.mockResolvedValue(Ok(false));
		expect((await run(onSub(), 'sleep_until', '{"seconds":60}')).unwrapErr().kind).toBe('conflict');
	});

	test('a sleep is counted from when the call is made, not from when the turn began', async () => {
		// The turn began at ten; the model asks for a minute's sleep three minutes into it.
		let time = now;
		const surface = toolSurfaceFor(store, sub, {id: 'job-2'}, 'w1', () => time);
		time = new Date('2026-10-21T10:03:00Z');

		expect((await run(surface, 'sleep_until', '{"seconds":60}')).unwrap()).toMatchObject({text: expect.stringContaining('Sleeping until 2026-10-21T10:04:00.000Z')});
		expect(store.scheduleWake).toHaveBeenCalledWith('job-2', 'w1', 'thread-1', new Date('2026-10-21T10:04:00Z'));
	});

	test('a message to the agent a sub-agent works for is sent, fenced by the job', async () => {
		expect((await run(onSub(), 'send_to_parent', '{"text":"Halfway."}')).unwrap()).toEqual({
			text: 'Sent.',
			isError: false,
		});
		expect(store.tellParentInline).toHaveBeenCalledWith(subJob, {text: 'Halfway.', isError: false});

		expect((await run(onSub(), 'send_to_parent', '{}')).unwrap()).toEqual({text: 'Give text, the message.', isError: true});

		store.tellParentInline.mockResolvedValue(Ok(false));
		expect((await run(onSub(), 'send_to_parent', '{"text":"Halfway."}')).unwrapErr().kind).toBe('conflict');
	});

	test('a sub-agent is started as the call says, and answered with its id', async () => {
		expect((await run(onMain(), 'create_subagent', '{"title":"Find the invoices","brief":"Search the mailbox."}', 'c7')).unwrap()).toEqual({
			text: 'Started “Find the invoices”, id thread-9.',
			isError: false,
		});
		expect(store.startSubAgentInline).toHaveBeenCalledWith(mainJob, {
			callId: 'c7',
			title: 'Find the invoices',
			task: expect.objectContaining({
				orgId: 'org-1',
				agentId: 'agent-1',
				ownerUserId: 'user-1',
				personaId: 'persona-1',
				parentId: null,
				title: 'Find the invoices',
				goal: 'Search the mailbox.',
				via: 'harness',
			}),
			entries: [{kind: 'person', text: 'Search the mailbox.'}],
		});

		expect((await run(onMain(), 'create_subagent', '{"title":"Find"}')).unwrap()).toEqual({text: 'Give title, a few words, and brief, what to do.', isError: true});

		store.startSubAgentInline.mockResolvedValue(Ok(null));
		expect((await run(onMain(), 'create_subagent', '{"title":"a","brief":"b"}')).unwrapErr().kind).toBe('conflict');
	});

	test('a message to a sub-agent is sent, and answered with what it was up to, or that there is no such sub-agent', async () => {
		expect((await run(onMain(), 'send_to_subagent', '{"subagent":"thread-1","text":"Any from before October?"}')).unwrap()).toEqual({
			text: 'Sent to “Find the invoices”, which was asleep, and is woken by it.',
			isError: false,
		});
		expect(store.messageSubAgentInline).toHaveBeenCalledWith(mainJob, 'thread-1', {kind: 'person', text: 'Any from before October?'});

		store.messageSubAgentInline.mockResolvedValue(Ok({subAgent: null}));
		expect((await run(onMain(), 'send_to_subagent', '{"subagent":"thread-8","text":"Hi"}')).unwrap()).toEqual({
			text: 'No sub-agent thread-8.',
			isError: true,
		});

		expect((await run(onMain(), 'send_to_subagent', '{"subagent":"thread-1"}')).unwrap()).toEqual({text: 'Give subagent, the sub-agent’s id, and text, the message.', isError: true});

		store.messageSubAgentInline.mockResolvedValue(Ok(null));
		expect((await run(onMain(), 'send_to_subagent', '{"subagent":"thread-1","text":"Hi"}')).unwrapErr().kind).toBe('conflict');
	});

	test('set_alert sets the alert on its own, fenced by the job, a watch on the connections the agent may read with the collection, and answers with it; cancel_alert deletes one', async () => {
		expect((await run(onMain(), 'set_alert', '{"title":"Call Dana","brief":"Remind them.","at":"2026-10-22T07:30:00Z"}')).unwrap()).toEqual({
			text: 'Set the alert alert-1: “Call Dana”, due 2026-10-22T07:30:00.000Z.',
			isError: false,
		});
		expect(store.setAlertInline).toHaveBeenCalledWith(mainJob, {kind: 'time', title: 'Call Dana', brief: 'Remind them.', at: new Date('2026-10-22T07:30:00Z')});

		await run(onMain(), 'set_alert', '{"title":"Bank","brief":"Tell me.","collection":"emails","terms":["Loan"]}');
		expect(store.setAlertInline).toHaveBeenLastCalledWith(mainJob, {kind: 'watch', title: 'Bank', brief: 'Tell me.', collectionId: 'emails', connectionIds: ['conn-a'], terms: ['loan']});

		expect((await run(onMain(), 'set_alert', '{"title":"Bank","brief":"Tell me.","collection":"emails","connections":["conn-b"]}')).unwrap()).toEqual({
			text: 'You may not watch conn-b for emails. The connections you may watch for it: conn-a (Google (a@example.com)).',
			isError: true,
		});
		expect((await run(onMain(), 'set_alert', '{"title":"Bank","brief":"Tell me."}')).unwrap()).toEqual({
			text: 'Give at, for one message at that time, or collection, for a watch: one of the two.',
			isError: true,
		});
		expect(store.setAlertInline).toHaveBeenCalledTimes(2);

		store.setAlertInline.mockResolvedValue(Ok(null));
		expect((await run(onMain(), 'set_alert', '{"title":"Call Dana","brief":"Remind them.","at":"2026-10-22T07:30:00Z"}')).unwrapErr().kind).toBe('conflict');

		expect((await run(onMain(), 'cancel_alert', '{"id":"alert-1"}')).unwrap()).toEqual({text: 'Cancelled the alert alert-1.', isError: false});
		expect(store.deleteAlert).toHaveBeenCalledWith('alert-1', {threadId: 'thread-0'});
		store.deleteAlert.mockResolvedValue(Ok(false));
		expect((await run(onMain(), 'cancel_alert', '{"id":"alert-2"}')).unwrap()).toEqual({
			text: 'No alert alert-2.',
			isError: true,
		});
	});

	test('a chat thread’s script, sleep and alerts are run as the thread’s own, for its task', async () => {
		const surface = onThread();
		expect(surface.tools.map((candidate) => candidate.name)).toEqual(['script', 'send_to_person', 'sleep_until', 'set_alert', 'cancel_alert']);

		const code = 'return pap.call("mail-1", "emails_list")';
		expect((await run(surface, 'script', JSON.stringify({code}))).unwrap()).toEqual({text: '{"records":[]}', isError: false});
		expect(callMcpTool).toHaveBeenCalledWith(signedIn, {code, task: 'task-1'}, 'harness');

		expect((await run(surface, 'sleep_until', '{"seconds":60}')).unwrap()).toMatchObject({isError: false, endTurn: true});
		expect(store.scheduleWake).toHaveBeenCalledWith('job-3', 'w1', 'thread-2', new Date('2026-10-21T10:01:00Z'));

		expect((await run(surface, 'set_alert', '{"title":"Call Dana","brief":"Remind them.","at":"2026-10-22T07:30:00Z"}')).unwrap()).toEqual({
			text: 'Set the alert alert-1: “Call Dana”, due 2026-10-22T07:30:00.000Z.',
			isError: false,
		});
		expect(store.setAlertInline).toHaveBeenCalledWith(threadJob, {kind: 'time', title: 'Call Dana', brief: 'Remind them.', at: new Date('2026-10-22T07:30:00Z')});
		expect((await run(surface, 'cancel_alert', '{"id":"alert-1"}')).unwrap()).toEqual({text: 'Cancelled the alert alert-1.', isError: false});
		expect(store.deleteAlert).toHaveBeenCalledWith('alert-1', {threadId: 'thread-2'});
	});

	test('a chat thread’s message to the person is answered at once, nothing written for it: the call is what the person reads', async () => {
		expect((await run(onThread(), 'send_to_person', '{"text":"Halfway through the invoices."}')).unwrap()).toEqual({text: 'Sent.', isError: false});
		expect((await run(onThread(), 'send_to_person', '{}')).unwrap()).toEqual({text: 'Give text, the message.', isError: true});
		expect(store.tellParentInline).not.toHaveBeenCalled();
		expect(store.appendTurnEntries).not.toHaveBeenCalled();
	});

	test('a chat thread has no sub-agents and no parent to tell, and the others have no message to the person', async () => {
		for (const [name, args] of [
			['create_subagent', '{"title":"a","brief":"b"}'],
			['send_to_subagent', '{"subagent":"thread-1","text":"Hi"}'],
			['send_to_parent', '{"text":"Hi"}'],
		] as const) {
			expect((await run(onThread(), name, args)).unwrap()).toEqual({text: `There is no tool ${name}.`, isError: true});
		}
		expect((await run(onMain(), 'send_to_person', '{"text":"Hi"}')).unwrap()).toEqual({text: 'There is no tool send_to_person.', isError: true});
		expect((await run(onSub(), 'send_to_person', '{"text":"Hi"}')).unwrap()).toEqual({text: 'There is no tool send_to_person.', isError: true});
		expect(store.startSubAgentInline).not.toHaveBeenCalled();
		expect(store.messageSubAgentInline).not.toHaveBeenCalled();
		expect(store.tellParentInline).not.toHaveBeenCalled();
	});

	test('never writes to the log, nor ends the job: the result is the worker’s to write', async () => {
		await run(onSub(), 'script', '{"code":"return 1"}');
		await run(onSub(), 'sleep_until', '{"seconds":60}');
		await run(onMain(), 'create_subagent', '{"title":"a","brief":"b"}');
		await run(onMain(), 'set_alert', '{"title":"Call Dana","brief":"Remind them.","at":"2026-10-22T07:30:00Z"}');
		expect(store.appendTurnEntries).not.toHaveBeenCalled();
		expect(store.completeToolJob).not.toHaveBeenCalled();
		expect(store.completeSetAlert).not.toHaveBeenCalled();
		expect(store.completeInference).not.toHaveBeenCalled();
		expect(store.finishJob).not.toHaveBeenCalled();
	});
});
