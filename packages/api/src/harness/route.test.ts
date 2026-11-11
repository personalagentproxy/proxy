import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {HarnessBackend} from '@proxy/backends/harness/backend';
import {fakeHarness} from '@proxy/backends/harness/fake';
import type {EntryRow, JobRow, SubAgentRow, ThreadRow} from '@proxy/db/harness';

import type {HarnessRegistry} from '../backends/harness';
import {type FakeStore, fakeStore} from './fake-store';

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['openrouter']};
const requireViewer = mock(async () => Ok(viewer));
mock.module('../utils/user-org', () => ({requireViewer}));

const ensureBuiltInAgent = mock(async () => Ok({id: 'login-1'}));
mock.module('./built-in-agent', () => ({ensureBuiltInAgent}));

const now = new Date('2026-10-21T10:00:00Z');
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
const persona = {id: 'persona-1', name: 'Finance', look, color: 'blue', harness: 'proxy', chatModel: 'claude', ownerUserId: 'user-1', createdById: 'user-1', createdAt: now};
const personaResponse = {
	id: 'persona-1',
	name: 'Finance',
	look,
	color: 'blue' as const,
	harness: 'proxy',
	chatModel: 'claude',
	shared: false,
	mayChange: true,
	lastMessage: null,
	draft: null,
	createdAt: '2026-10-21T10:00:00.000Z',
};

// The harnesses the server has, unless a test says otherwise: the loop over OpenRouter, with its
// two models, which the viewer's organization is offered with the `openrouter` experiment, and
// the Claude Agent SDK's, with its three.
const proxy: HarnessBackend = {
	...fakeHarness('proxy'),
	label: 'OpenRouter',
	models: [
		{id: 'claude', label: 'Claude Sonnet 5.5'},
		{id: 'glm', label: 'GLM 5.3'},
	],
};
const sdk: HarnessBackend = {
	...fakeHarness('claude-agent-sdk'),
	label: 'Claude',
	models: [
		{id: 'sonnet', label: 'Claude Sonnet 5.5'},
		{id: 'opus', label: 'Claude Opus 5.5'},
		{id: 'fable', label: 'Claude Fable 5.2'},
	],
};
let registry: HarnessRegistry = {proxy, claudeAgentSdk: sdk};
const offered = [
	{id: 'claude-agent-sdk', label: 'Claude', models: sdk.models},
	{id: 'proxy', label: 'OpenRouter', models: proxy.models},
];
const thread: ThreadRow = {
	id: 'thread-1',
	orgId: 'org-1',
	agentId: 'login-1',
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

function request(params: Record<string, string> = {}, body: unknown = undefined) {
	return {user: {userId: 'user-1', email: 'a@example.com'}, params, body} as never;
}

let store: FakeStore;
let routes: ReturnType<typeof import('./route').chatRoutes>;

// An entry of the log, as the store gives it.
function logEntry(entry: Pick<EntryRow, 'id' | 'seq' | 'kind' | 'text'> & Partial<EntryRow>): EntryRow {
	return {
		threadId: 'thread-1',
		pending: false,
		toolCalls: null,
		callId: null,
		isError: false,
		direct: false,
		inputTokens: null,
		outputTokens: null,
		coversSeq: null,
		system: null,
		harness: null,
		model: null,
		jobId: null,
		createdAt: now,
		...entry,
	};
}

// A call the model made, its arguments as JSON.
function call(id: string, name: string, args: Record<string, string>) {
	return {id, name, arguments: JSON.stringify(args)};
}

// A sub-agent started from the conversation, at work unless the test says otherwise.
function subAgent(sub: Partial<SubAgentRow> & {id: string; parentCallId: string; title: string}): SubAgentRow {
	return {...thread, parentThreadId: 'thread-1', taskId: null, state: {kind: 'working'}, ...sub};
}

beforeEach(async () => {
	mock.clearAllMocks();
	store = fakeStore();
	registry = {proxy, claudeAgentSdk: sdk};
	routes = (await import('./route')).chatRoutes(store, () => registry);
	const {
		listPersonas,
		ensureFirstPersona,
		getPersona,
		createPersona,
		updatePersona,
		deletePersona,
		getMemberThread,
		ensureMemberThread,
		listShownEntries,
		listOpenJobs,
		appendPersonMessage,
		getThreadDraft,
	} = store;
	deletePersona.mockResolvedValue(Ok(true));
	ensureFirstPersona.mockResolvedValue(Ok({...persona, id: 'persona-9', name: 'General', ownerUserId: null, createdById: null}));
	requireViewer.mockResolvedValue(Ok(viewer));
	listPersonas.mockResolvedValue(Ok([{...persona, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}, draft: null}]));
	getPersona.mockResolvedValue(Ok(persona));
	createPersona.mockResolvedValue(Ok({...persona, id: 'persona-2'}));
	updatePersona.mockResolvedValue(Ok(true));
	getMemberThread.mockResolvedValue(Ok(thread));
	ensureMemberThread.mockResolvedValue(Ok(thread));
	listShownEntries.mockResolvedValue(
		Ok([logEntry({id: 'e1', seq: 1, kind: 'person', text: 'Hi'}), logEntry({id: 'e2', seq: 2, kind: 'summary', text: 'The person said hi.', inputTokens: 90_000, outputTokens: 10, coversSeq: 1})]),
	);
	listOpenJobs.mockResolvedValue(Ok([]));
	store.listSubAgents.mockResolvedValue(Ok([]));
	store.listPinnedTasks.mockResolvedValue(Ok([]));
	getThreadDraft.mockResolvedValue(Ok(null));
	appendPersonMessage.mockResolvedValue(Ok(logEntry({id: 'e3', seq: 3, kind: 'person', text: 'Hello'})));
});

describe('the chat routes', () => {
	test('offer OpenRouter only with the openrouter experiment: without it, a persona on it is shown on Claude, and none is made or switched to it', async () => {
		const {handleCreatePersonaRoute, handleListPersonasRoute, handleUpdatePersonaRoute} = routes;
		requireViewer.mockResolvedValue(Ok({...viewer, experiments: []}));
		store.listPersonas.mockResolvedValue(Ok([{...persona, ownerUserId: null, lastMessage: null, draft: null}]));

		const listed = (await handleListPersonasRoute(request())).unwrap();
		expect(listed.harnesses.map((harness) => harness.id)).toEqual(['claude-agent-sdk']);
		expect(listed.personas.map(({harness, chatModel}) => [harness, chatModel])).toEqual([['claude-agent-sdk', 'sonnet']]);

		const body = {name: 'Finance', look, color: 'blue', harness: 'proxy'};
		expect((await handleCreatePersonaRoute(request({}, body))).unwrapErr()).toMatchObject({kind: 'validation_error', message: 'This server has no harness proxy.'});
		expect((await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, body))).unwrapErr().kind).toBe('validation_error');
		expect(store.createPersona).not.toHaveBeenCalled();
		expect(store.updatePersona).not.toHaveBeenCalled();

		await handleCreatePersonaRoute(request({}, {name: 'Finance', look, color: 'blue'}));
		expect(store.createPersona).toHaveBeenCalledWith('org-1', 'user-1', {name: 'Finance', look, color: 'blue', harness: 'claude-agent-sdk', chatModel: 'sonnet'});
	});

	test('list the personas the viewer sees, their own and every member’s, with their heads, what runs each, whether the viewer may change each, and the last thing said with each and what the viewer typed and hasn’t sent, on one line, and the harnesses the server has with their models', async () => {
		const {handleListPersonasRoute} = routes;
		store.listPersonas.mockResolvedValue(
			Ok([
				{...persona, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}, draft: null},
				{...persona, id: 'persona-3', ownerUserId: null, createdById: 'user-2', lastMessage: null, draft: 'Move the **pricing review**\nto Friday'},
				{
					...persona,
					id: 'persona-4',
					lastMessage: {kind: 'assistant', text: '## Found\n\n- **Three** invoices, see [the list](https://x.test)\n\n| Who | Sum |\n| --- | --- |\n| Dana | 40 |\n\n```\ncode\n```', createdAt: now},
					draft: null,
				},
			]),
		);

		const listed = (await handleListPersonasRoute(request())).unwrap();

		expect(store.listPersonas).toHaveBeenCalledWith('org-1', 'user-1');
		expect(listed).toEqual({
			personas: [
				{...personaResponse, lastMessage: {kind: 'assistant', text: 'Your vault has one entry.', at: '2026-10-21T10:00:00.000Z'}},
				{...personaResponse, id: 'persona-3', shared: true, mayChange: false, draft: 'Move the pricing review to Friday'},
				{...personaResponse, id: 'persona-4', lastMessage: {kind: 'assistant', text: 'Found Three invoices, see the list Who Sum Dana 40', at: '2026-10-21T10:00:00.000Z'}},
			],
			pinnedTasks: [],
			harnesses: offered,
		});
	});

	test('list the persona’s last answer in each of the viewer’s conversations, on one line, and whether it is unread, making nothing', async () => {
		const {handleListAnswersRoute} = routes;
		store.listAnswers.mockResolvedValue(Ok([{personaId: 'persona-1', personaName: 'Finance', answer: {id: 'e9', text: 'Your vault\n has  one entry.'}, unread: true}]));

		const listed = (await handleListAnswersRoute(request())).unwrap();

		expect(store.listAnswers).toHaveBeenCalledWith('org-1', 'user-1');
		expect(store.ensureFirstPersona).not.toHaveBeenCalled();
		expect(listed).toEqual({answers: [{personaId: 'persona-1', name: 'Finance', answer: {id: 'e9', text: 'Your vault has one entry.'}, unread: true}]});
	});

	test('a viewer who sees no persona gets the organization’s General one, every member’s, on their first listing', async () => {
		const {handleListPersonasRoute} = routes;
		store.listPersonas.mockResolvedValue(Ok([]));
		store.ensureFirstPersona.mockResolvedValue(Ok({...persona, id: 'persona-9', name: 'General', ownerUserId: null, createdById: null}));

		const listed = (await handleListPersonasRoute(request())).unwrap();

		expect(store.ensureFirstPersona).toHaveBeenCalledWith('org-1');
		expect(listed).toEqual({personas: [{...personaResponse, id: 'persona-9', name: 'General', shared: true, mayChange: false}], pinnedTasks: [], harnesses: offered});
	});

	test('a viewer who sees personas of their own but none every member’s, as where General was deleted, gets General made again, after their own', async () => {
		const {handleListPersonasRoute} = routes;

		const listed = (await handleListPersonasRoute(request())).unwrap();

		expect(store.ensureFirstPersona).toHaveBeenCalledWith('org-1');
		expect(listed.personas.map(({id, shared}) => [id, shared])).toEqual([
			['persona-1', false],
			['persona-9', true],
		]);
	});

	test('make a persona as given, the viewer’s own, on the server’s first harness with its first model where none was chosen, with the organization’s built-in login where there is none', async () => {
		const {handleCreatePersonaRoute} = routes;

		const made = await handleCreatePersonaRoute(request({}, {name: ' Finance ', look, color: 'blue'}));

		expect(ensureBuiltInAgent).toHaveBeenCalledWith('org-1');
		expect(store.createPersona).toHaveBeenCalledWith('org-1', 'user-1', {name: 'Finance', look, color: 'blue', harness: 'claude-agent-sdk', chatModel: 'sonnet'});
		expect(made.unwrap().persona).toEqual({...personaResponse, id: 'persona-2'});
	});

	test('refuse a persona without a name, with a look outside the lab’s range, or a color outside the catalog', async () => {
		const {handleCreatePersonaRoute} = routes;

		expect((await handleCreatePersonaRoute(request({}, {name: ' ', look, color: 'blue'}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleCreatePersonaRoute(request({}, {name: 'Finance', look: {...look, nose: 2}, color: 'blue'}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleCreatePersonaRoute(request({}, {name: 'Finance', look, color: 'brown'}))).unwrapErr().kind).toBe('parse_error');
		expect(store.createPersona).not.toHaveBeenCalled();
	});

	test('rename a persona or change its head, and delete one with every conversation, for whose it is, and of one every member sees, for whoever made it or owns the organization', async () => {
		const {handleDeletePersonaRoute, handleUpdatePersonaRoute} = routes;
		const changed = {name: 'Money', look: {...look, eyes: 1 as const}, color: 'green' as const};

		const updated = await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, changed));
		expect(store.getPersona).toHaveBeenCalledWith('org-1', 'user-1', 'persona-1');
		expect(store.updatePersona).toHaveBeenCalledWith('org-1', 'persona-1', changed);
		expect(updated.unwrap().persona).toEqual({...personaResponse, ...changed});

		store.getPersona.mockResolvedValue(Ok({...persona, ownerUserId: null, createdById: 'user-2'}));
		expect((await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, changed))).unwrapErr().kind).toBe('forbidden');
		expect((await handleDeletePersonaRoute(request({personaId: 'persona-1'}))).unwrapErr().kind).toBe('forbidden');
		expect(store.deletePersona).not.toHaveBeenCalled();

		requireViewer.mockResolvedValue(Ok({...viewer, role: 'owner'}));
		expect((await handleDeletePersonaRoute(request({personaId: 'persona-1'}))).isOk()).toBe(true);
		expect(store.deletePersona).toHaveBeenCalledWith('org-1', 'persona-1');

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleDeletePersonaRoute(request({personaId: 'nope'}))).unwrapErr()).toMatchObject({kind: 'not_found'});
	});

	test('make a persona on the harness and the model chosen, switch it to another of either, and show what runs it', async () => {
		const {handleCreatePersonaRoute, handleUpdatePersonaRoute} = routes;
		const onSdk = {name: 'Finance', look, color: 'blue' as const, harness: 'claude-agent-sdk', chatModel: 'opus'};
		store.createPersona.mockResolvedValue(Ok({...persona, id: 'persona-2', harness: 'claude-agent-sdk', chatModel: 'opus'}));

		const made = await handleCreatePersonaRoute(request({}, onSdk));
		expect(store.createPersona).toHaveBeenCalledWith('org-1', 'user-1', onSdk);
		expect(made.unwrap().persona).toEqual({...personaResponse, id: 'persona-2', harness: 'claude-agent-sdk', chatModel: 'opus'});

		// Another model of the harness it has, the harness left out.
		const switched = await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, {name: 'Finance', look, color: 'blue', chatModel: 'glm'}));
		expect(store.updatePersona).toHaveBeenLastCalledWith('org-1', 'persona-1', {name: 'Finance', look, color: 'blue', harness: 'proxy', chatModel: 'glm'});
		expect(switched.unwrap().persona).toMatchObject({harness: 'proxy', chatModel: 'glm'});

		// Another harness, the model left out: the harness's first, not the one it had on the other.
		const moved = await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, {name: 'Finance', look, color: 'blue', harness: 'claude-agent-sdk'}));
		expect(store.updatePersona).toHaveBeenLastCalledWith('org-1', 'persona-1', {name: 'Finance', look, color: 'blue', harness: 'claude-agent-sdk', chatModel: 'sonnet'});
		expect(moved.unwrap().persona).toMatchObject({harness: 'claude-agent-sdk', chatModel: 'sonnet'});

		// Neither named, a persona changed keeps what it has.
		const renamed = await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, {name: 'Money', look, color: 'blue'}));
		expect(store.updatePersona).toHaveBeenLastCalledWith('org-1', 'persona-1', {name: 'Money', look, color: 'blue'});
		expect(renamed.unwrap().persona).toMatchObject({harness: 'proxy', chatModel: 'claude'});
	});

	test('refuse a harness the server hasn’t got, and a model the harness hasn’t got, another harness’s among them', async () => {
		const {handleCreatePersonaRoute, handleUpdatePersonaRoute} = routes;
		const body = {name: 'Finance', look, color: 'blue'};

		expect((await handleCreatePersonaRoute(request({}, {...body, harness: 'codex'}))).unwrapErr()).toMatchObject({kind: 'validation_error', message: 'This server has no harness codex.'});
		expect((await handleCreatePersonaRoute(request({}, {...body, harness: 'proxy', chatModel: 'opus'}))).unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message: 'OpenRouter has no model opus.',
		});
		expect((await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, {...body, chatModel: 'gpt'}))).unwrapErr().kind).toBe('validation_error');

		registry = {proxy, claudeAgentSdk: null};
		expect((await handleCreatePersonaRoute(request({}, {...body, harness: 'claude-agent-sdk'}))).unwrapErr().kind).toBe('validation_error');
		expect(store.createPersona).not.toHaveBeenCalled();
		expect(store.updatePersona).not.toHaveBeenCalled();
	});

	test('a persona on a harness the server hasn’t got, or a model its harness no longer has, is shown as what runs it here: the server’s first harness, the harness’s first model', async () => {
		const {handleListPersonasRoute} = routes;
		registry = {proxy, claudeAgentSdk: null};
		store.listPersonas.mockResolvedValue(
			Ok([
				{...persona, harness: 'claude-agent-sdk', chatModel: 'opus', lastMessage: null, draft: null},
				{...persona, id: 'persona-3', ownerUserId: null, chatModel: 'dropped-long-ago', lastMessage: null, draft: null},
			]),
		);

		const listed = (await handleListPersonasRoute(request())).unwrap();

		expect(listed.personas.map(({harness, chatModel}) => [harness, chatModel])).toEqual([
			['proxy', 'claude'],
			['proxy', 'claude'],
		]);
		expect(listed.harnesses.map((harness) => harness.id)).toEqual(['proxy']);

		// A server with no harness at all shows what is kept, and offers none.
		registry = {proxy: null, claudeAgentSdk: null};
		const bare = (await handleListPersonasRoute(request())).unwrap();
		expect(bare.personas[0]).toMatchObject({harness: 'claude-agent-sdk', chatModel: 'opus'});
		expect(bare.harnesses).toEqual([]);
	});

	test('give the viewer’s conversation with the persona, begun through the built-in login where there was none, as turns alone, with whether the persona is busy', async () => {
		const {handleGetThreadRoute} = routes;
		const soon = new Date(Date.now() + 60_000);
		const base: Omit<JobRow, 'runAt'> = {id: 'j1', threadId: 'thread-1', kind: 'tool', status: 'queued', entryId: 'e1', callId: 'c1', claimedBy: null, attempts: 0};

		const idle = (await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap();
		expect(idle.persona).toEqual(personaResponse);
		expect(idle.entries).toEqual([{id: 'e1', kind: 'person', text: 'Hi', isError: false, at: '2026-10-21T10:00:00.000Z'}]);
		expect(idle).toMatchObject({busy: false, draft: null});
		expect(store.getThreadDraft).toHaveBeenCalledWith('thread-1');
		expect(store.ensureMemberThread).not.toHaveBeenCalled();
		expect(ensureBuiltInAgent).not.toHaveBeenCalled();

		store.getMemberThread.mockResolvedValue(Ok(null));
		store.listOpenJobs.mockResolvedValue(Ok([{...base, runAt: new Date(Date.now() - 1000)}]));
		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap()).toMatchObject({busy: true});
		expect(ensureBuiltInAgent).toHaveBeenCalledWith('org-1');
		expect(store.ensureMemberThread).toHaveBeenCalledWith({orgId: 'org-1', agentId: 'login-1', personaId: 'persona-1', userId: 'user-1'});

		store.listOpenJobs.mockResolvedValue(Ok([{...base, runAt: soon}]));
		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap()).toMatchObject({busy: false});

		// A turn of the model to be tried again in a moment is work under way, not sleep.
		store.listOpenJobs.mockResolvedValue(Ok([{...base, kind: 'inference' as const, entryId: null, callId: null, runAt: soon}]));
		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap()).toMatchObject({busy: true});

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleGetThreadRoute(request({personaId: 'nope'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'persona'});
	});

	test('append what the person says, trimmed, and refuse nothing or too much', async () => {
		const {handlePostMessageRoute} = routes;

		const posted = await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: '  Hello \n'}));
		expect(store.appendPersonMessage).toHaveBeenCalledWith('thread-1', 'Hello');
		expect(posted.unwrap().entry).toMatchObject({id: 'e3', kind: 'person', text: 'Hello'});

		expect((await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: '   '}))).unwrapErr().kind).toBe('parse_error');
		expect((await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: 'x'.repeat(20_001)}))).unwrapErr().kind).toBe('parse_error');
	});

	test('show the tasks the persona started where it started them, and what it sent one later, where it sent it', async () => {
		const {handleGetThreadRoute} = routes;
		store.listSubAgents.mockResolvedValue(Ok([subAgent({id: 'sub-1', parentCallId: 'c1', title: 'Find flights'}), subAgent({id: 'sub-2', parentCallId: 'c2', title: 'Check the calendar'})]));
		store.listShownEntries.mockResolvedValue(
			Ok([
				logEntry({id: 'e1', seq: 1, kind: 'person', text: 'Find me flights to Lisbon'}),
				logEntry({
					id: 'e2',
					seq: 2,
					kind: 'assistant',
					text: 'Looking into it.',
					toolCalls: [
						call('c1', 'create_subagent', {title: 'Find flights', brief: 'Flights to Lisbon'}),
						call('c2', 'create_subagent', {title: 'Check the calendar', brief: 'Free days'}),
						call('c3', 'create_subagent', {title: '', brief: ''}),
					],
				}),
				logEntry({
					id: 'e3',
					seq: 3,
					kind: 'assistant',
					text: '',
					toolCalls: [call('c4', 'send_to_subagent', {subagent: 'sub-1', text: 'Only direct ones'}), call('c5', 'send_to_subagent', {subagent: 'sub-9', text: 'Hello'})],
				}),
			]),
		);

		const log = (await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap();

		expect(store.listShownEntries).toHaveBeenCalledWith('thread-1', ['create_subagent', 'send_to_subagent']);
		expect(store.listSubAgents).toHaveBeenCalledWith('thread-1', expect.any(Date));
		expect(log.entries).toEqual([
			{id: 'e1', kind: 'person', text: 'Find me flights to Lisbon', isError: false, at: '2026-10-21T10:00:00.000Z'},
			{id: 'e2', kind: 'assistant', text: 'Looking into it.', isError: false, at: '2026-10-21T10:00:00.000Z'},
			{id: 'e2:c1', kind: 'task', task: {id: 'sub-1', title: 'Find flights'}, at: '2026-10-21T10:00:00.000Z'},
			{id: 'e2:c2', kind: 'task', task: {id: 'sub-2', title: 'Check the calendar'}, at: '2026-10-21T10:00:00.000Z'},
			{id: 'e3:c4', kind: 'sent', task: {id: 'sub-1', title: 'Find flights'}, at: '2026-10-21T10:00:00.000Z'},
		]);
	});

	test('show what the persona started or sent without a word under its next words in the turn, or where the turn ended', async () => {
		const {handleGetThreadRoute} = routes;
		const later = new Date('2026-10-21T10:00:05.000Z');
		store.listSubAgents.mockResolvedValue(Ok([subAgent({id: 'sub-1', parentCallId: 'c1', title: 'Weekly check'})]));
		store.listShownEntries.mockResolvedValue(
			Ok([
				logEntry({id: 'e1', seq: 1, kind: 'assistant', text: '', toolCalls: [call('c2', 'send_to_subagent', {subagent: 'sub-1', text: 'Run it'})]}),
				logEntry({id: 'e2', seq: 3, kind: 'assistant', text: 'I’m running the check.', createdAt: later}),
				logEntry({id: 'e3', seq: 5, kind: 'assistant', text: 'All quiet.', createdAt: later}),
				logEntry({id: 'e4', seq: 6, kind: 'assistant', text: '', toolCalls: [call('c3', 'send_to_subagent', {subagent: 'sub-1', text: 'Again'})]}),
				logEntry({id: 'e5', seq: 8, kind: 'assistant', text: '', createdAt: later}),
				logEntry({id: 'e6', seq: 9, kind: 'assistant', text: 'Here it is again.', createdAt: later}),
			]),
		);

		const log = (await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap();

		expect(log.entries).toEqual([
			{id: 'e2', kind: 'assistant', text: 'I’m running the check.', isError: false, at: '2026-10-21T10:00:05.000Z'},
			{id: 'e1:c2', kind: 'sent', task: {id: 'sub-1', title: 'Weekly check'}, at: '2026-10-21T10:00:05.000Z'},
			{id: 'e3', kind: 'assistant', text: 'All quiet.', isError: false, at: '2026-10-21T10:00:05.000Z'},
			{id: 'e4:c3', kind: 'sent', task: {id: 'sub-1', title: 'Weekly check'}, at: '2026-10-21T10:00:05.000Z'},
			{id: 'e6', kind: 'assistant', text: 'Here it is again.', isError: false, at: '2026-10-21T10:00:05.000Z'},
		]);
	});

	test('give a task’s chat: the persona’s brief and messages, the viewer’s own, and what the task answered and told the persona, without its calls, and its failures', async () => {
		const {handleGetTaskRoute} = routes;
		const task = subAgent({id: 'sub-1', parentCallId: 'c1', title: 'Find flights', taskId: 'task-7', state: {kind: 'stopped'}});
		store.listSubAgents.mockResolvedValue(Ok([task]));
		store.listShownSubAgentEntries.mockResolvedValue(
			Ok([
				logEntry({id: 's1', seq: 4, threadId: 'sub-1', kind: 'person', text: 'Flights to Lisbon'}),
				logEntry({
					id: 's2',
					seq: 5,
					threadId: 'sub-1',
					kind: 'assistant',
					text: 'Searching.',
					toolCalls: [call('k1', 'script', {code: 'pap.call()'}), call('k2', 'send_to_parent', {text: 'Two airlines so far'})],
				}),
				logEntry({id: 's3', seq: 6, threadId: 'sub-1', kind: 'assistant', text: 'Three direct flights.'}),
				logEntry({id: 's4', seq: 7, threadId: 'sub-1', kind: 'person', text: 'Only mornings', direct: true}),
				logEntry({id: 'e9', seq: 8, threadId: 'thread-1', kind: 'event', callId: 'c1', text: 'The sub-agent failed: no model.\n\n(It has stopped; a message takes it up again.)', isError: true}),
			]),
		);

		const chat = (await handleGetTaskRoute(request({personaId: 'persona-1', taskId: 'sub-1'}))).unwrap();

		expect(store.listShownSubAgentEntries).toHaveBeenCalledWith(task, ['send_to_parent']);
		expect(chat.persona).toEqual(personaResponse);
		expect(chat.task).toEqual({id: 'sub-1', title: 'Find flights'});
		expect(chat.busy).toBe(false);
		expect(chat.activityTaskId).toBe('task-7');
		expect(chat.entries.map(({id, from, text, isError}) => ({id, from, text, isError}))).toEqual([
			{id: 's1', from: 'persona', text: 'Flights to Lisbon', isError: false},
			{id: 's2:k2', from: 'task', text: 'Two airlines so far', isError: false},
			{id: 's3', from: 'task', text: 'Three direct flights.', isError: false},
			{id: 's4', from: 'person', text: 'Only mornings', isError: false},
			{id: 'e9', from: 'task', text: 'The sub-agent failed: no model.', isError: true},
		]);

		// Another conversation's task, or one of a conversation the viewer never began, is none of theirs.
		expect((await handleGetTaskRoute(request({personaId: 'persona-1', taskId: 'sub-9'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'task'});
		store.getMemberThread.mockResolvedValue(Ok(null));
		expect((await handleGetTaskRoute(request({personaId: 'persona-1', taskId: 'sub-1'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'task'});
		expect(store.ensureMemberThread).not.toHaveBeenCalled();
	});

	test('list the tasks the viewer pinned, as the store orders them, and pin or unpin one of their conversation’s', async () => {
		const {handleListPersonasRoute, handlePinTaskRoute} = routes;
		store.listPinnedTasks.mockResolvedValue(
			Ok([
				{id: 'sub-2', personaId: 'persona-1', title: 'Check the calendar', lastActiveAt: now},
				{id: 'sub-1', personaId: 'persona-3', title: 'Find flights', lastActiveAt: now},
			]),
		);

		expect((await handleListPersonasRoute(request())).unwrap().pinnedTasks).toEqual([
			{id: 'sub-2', personaId: 'persona-1', title: 'Check the calendar'},
			{id: 'sub-1', personaId: 'persona-3', title: 'Find flights'},
		]);
		expect(store.listPinnedTasks).toHaveBeenCalledWith('org-1', 'user-1');

		store.setTaskPinned.mockResolvedValue(Ok(true));
		expect((await handlePinTaskRoute(request({personaId: 'persona-1', taskId: 'sub-1'}, {pinned: true}))).isOk()).toBe(true);
		expect(store.setTaskPinned).toHaveBeenLastCalledWith('thread-1', 'sub-1', true);
		expect((await handlePinTaskRoute(request({personaId: 'persona-1', taskId: 'sub-1'}, {pinned: false}))).isOk()).toBe(true);
		expect(store.setTaskPinned).toHaveBeenLastCalledWith('thread-1', 'sub-1', false);

		expect((await handlePinTaskRoute(request({personaId: 'persona-1', taskId: 'sub-1'}, {}))).unwrapErr().kind).toBe('parse_error');
		store.setTaskPinned.mockResolvedValue(Ok(false));
		expect((await handlePinTaskRoute(request({personaId: 'persona-1', taskId: 'sub-9'}, {pinned: true}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'task'});
		store.getMemberThread.mockResolvedValue(Ok(null));
		expect((await handlePinTaskRoute(request({personaId: 'persona-1', taskId: 'sub-1'}, {pinned: true}))).unwrapErr().kind).toBe('not_found');
		expect(store.setTaskPinned).toHaveBeenCalledTimes(3);
	});

	test('send what the viewer writes in a task’s chat to the task, trimmed, and say where there is no such task', async () => {
		const {handlePostTaskMessageRoute} = routes;
		store.messageSubAgentDirectly.mockResolvedValue(Ok(true));

		expect((await handlePostTaskMessageRoute(request({personaId: 'persona-1', taskId: 'sub-1'}, {text: ' Only mornings \n'}))).isOk()).toBe(true);
		expect(store.messageSubAgentDirectly).toHaveBeenCalledWith('thread-1', 'sub-1', 'Only mornings');

		expect((await handlePostTaskMessageRoute(request({personaId: 'persona-1', taskId: 'sub-1'}, {text: ' '}))).unwrapErr().kind).toBe('parse_error');

		store.messageSubAgentDirectly.mockResolvedValue(Ok(false));
		expect((await handlePostTaskMessageRoute(request({personaId: 'persona-1', taskId: 'sub-9'}, {text: 'Hi'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'task'});

		store.getMemberThread.mockResolvedValue(Ok(null));
		expect((await handlePostTaskMessageRoute(request({personaId: 'persona-1', taskId: 'sub-1'}, {text: 'Hi'}))).unwrapErr().kind).toBe('not_found');
		expect(store.messageSubAgentDirectly).toHaveBeenCalledTimes(2);
	});

	test('give what the viewer typed in the conversation and hasn’t sent, whole', async () => {
		const {handleGetThreadRoute} = routes;
		store.getThreadDraft.mockResolvedValue(Ok('Move the pricing review\nto Friday'));

		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap().draft).toBe('Move the pricing review\nto Friday');
	});

	test('keep what the viewer typed and hasn’t sent as it is, forget nothing but whitespace, and refuse too much', async () => {
		const {handleSaveDraftRoute} = routes;
		store.saveThreadDraft.mockResolvedValue(Ok(true));

		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: '  Move the pricing review\n'}))).isOk()).toBe(true);
		expect(store.saveThreadDraft).toHaveBeenLastCalledWith('thread-1', '  Move the pricing review\n');

		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: ' \n '}))).isOk()).toBe(true);
		expect(store.saveThreadDraft).toHaveBeenLastCalledWith('thread-1', null);

		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: 'x'.repeat(20_001)}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {}))).unwrapErr().kind).toBe('parse_error');

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleSaveDraftRoute(request({personaId: 'persona-9'}, {text: 'Hi'}))).unwrapErr().kind).toBe('not_found');
		expect(store.saveThreadDraft).toHaveBeenCalledTimes(2);
	});

	test('mark the viewer’s conversation with the persona read up to the answer shown, beginning none, and say where the answer, the conversation or the persona is gone', async () => {
		const {handleMarkReadRoute} = routes;
		store.markThreadRead.mockResolvedValue(Ok(true));

		expect((await handleMarkReadRoute(request({personaId: 'persona-1'}, {entryId: 'e9'}))).isOk()).toBe(true);
		expect(store.markThreadRead).toHaveBeenCalledWith('thread-1', 'e9');

		expect((await handleMarkReadRoute(request({personaId: 'persona-1'}, {}))).unwrapErr().kind).toBe('parse_error');

		store.markThreadRead.mockResolvedValue(Ok(false));
		expect((await handleMarkReadRoute(request({personaId: 'persona-1'}, {entryId: 'elsewhere'}))).unwrapErr().kind).toBe('not_found');

		store.getMemberThread.mockResolvedValue(Ok(null));
		expect((await handleMarkReadRoute(request({personaId: 'persona-1'}, {entryId: 'e9'}))).unwrapErr().kind).toBe('not_found');
		expect(store.ensureMemberThread).not.toHaveBeenCalled();
		expect(ensureBuiltInAgent).not.toHaveBeenCalled();

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleMarkReadRoute(request({personaId: 'persona-9'}, {entryId: 'e9'}))).unwrapErr().kind).toBe('not_found');
		expect(store.markThreadRead).toHaveBeenCalledTimes(2);
	});
});
