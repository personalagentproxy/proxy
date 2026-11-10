import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {HarnessBackend} from '@proxy/backends/harness/backend';
import {fakeHarness} from '@proxy/backends/harness/fake';
import type {EntryRow, JobRow, ThreadRow} from '@proxy/db/harness';

import type {HarnessRegistry} from '../backends/harness';
import {type FakeStore, fakeStore} from './fake-store';

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['harness']};
const requireViewer = mock(async () => Ok(viewer));
mock.module('../utils/user-org', () => ({requireViewer}));

const ensureBuiltInAgent = mock(async () => Ok({id: 'login-1'}));
mock.module('./built-in-agent', () => ({ensureBuiltInAgent}));

const now = new Date('2026-10-21T10:00:00Z');
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
const persona = {id: 'persona-1', name: 'Finance', look, color: 'blue', harness: 'proxy', chatModel: 'claude', createdById: 'user-1', createdAt: now};
const personaResponse = {
	id: 'persona-1',
	name: 'Finance',
	look,
	color: 'blue' as const,
	harness: 'proxy',
	chatModel: 'claude',
	mayChange: true,
	lastMessage: null,
	draft: null,
	createdAt: '2026-10-21T10:00:00.000Z',
};

// The harnesses the server has, unless a test says otherwise: the loop over OpenRouter, with its
// two models, and the Claude Agent SDK's, with its three.
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
	{id: 'proxy', label: 'OpenRouter', models: proxy.models},
	{id: 'claude-agent-sdk', label: 'Claude', models: sdk.models},
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

beforeEach(async () => {
	mock.clearAllMocks();
	store = fakeStore();
	registry = {proxy, claudeAgentSdk: sdk};
	routes = (await import('./route')).chatRoutes(store, () => registry);
	const {listPersonas, getPersona, createPersona, updatePersona, deletePersona, getMemberThread, ensureMemberThread, listShownEntries, listOpenJobs, appendPersonMessage, getThreadDraft} = store;
	deletePersona.mockResolvedValue(Ok(true));
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
	getThreadDraft.mockResolvedValue(Ok(null));
	appendPersonMessage.mockResolvedValue(Ok(logEntry({id: 'e3', seq: 3, kind: 'person', text: 'Hello'})));
});

describe('the chat routes', () => {
	test('are refused without the experiment', async () => {
		const {handleListPersonasRoute, handleListAnswersRoute, handlePostMessageRoute} = routes;
		requireViewer.mockResolvedValue(Ok({...viewer, experiments: []}));

		expect((await handleListPersonasRoute(request())).unwrapErr().kind).toBe('forbidden');
		expect((await handleListAnswersRoute(request())).unwrapErr().kind).toBe('forbidden');
		expect((await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: 'Hi'}))).unwrapErr().kind).toBe('forbidden');
		expect(store.appendPersonMessage).not.toHaveBeenCalled();
	});

	test('list the organization’s personas, with their heads, what runs each, whether the viewer may change each, and the last thing said with each and what the viewer typed and hasn’t sent, on one line, and the harnesses the server has with their models', async () => {
		const {handleListPersonasRoute} = routes;
		store.listPersonas.mockResolvedValue(
			Ok([
				{...persona, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}, draft: null},
				{...persona, id: 'persona-3', createdById: 'user-2', lastMessage: null, draft: 'Move the **pricing review**\nto Friday'},
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
				{...personaResponse, id: 'persona-3', mayChange: false, draft: 'Move the pricing review to Friday'},
				{...personaResponse, id: 'persona-4', lastMessage: {kind: 'assistant', text: 'Found Three invoices, see the list Who Sum Dana 40', at: '2026-10-21T10:00:00.000Z'}},
			],
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

	test('an organization without a persona gets a General one, nobody’s, on its first listing', async () => {
		const {handleListPersonasRoute} = routes;
		store.listPersonas.mockResolvedValue(Ok([]));
		store.ensureFirstPersona.mockResolvedValue(Ok({...persona, id: 'persona-9', name: 'General', createdById: null}));

		const listed = (await handleListPersonasRoute(request())).unwrap();

		expect(store.ensureFirstPersona).toHaveBeenCalledWith('org-1');
		expect(listed).toEqual({personas: [{...personaResponse, id: 'persona-9', name: 'General', mayChange: false}], harnesses: offered});
	});

	test('make a persona as given, for everyone in the organization, on the server’s first harness with its first model where none was chosen, with the organization’s built-in login where there is none', async () => {
		const {handleCreatePersonaRoute} = routes;

		const made = await handleCreatePersonaRoute(request({}, {name: ' Finance ', look, color: 'blue'}));

		expect(ensureBuiltInAgent).toHaveBeenCalledWith('org-1');
		expect(store.createPersona).toHaveBeenCalledWith('org-1', 'user-1', {name: 'Finance', look, color: 'blue', harness: 'proxy', chatModel: 'claude'});
		expect(made.unwrap().persona).toEqual({...personaResponse, id: 'persona-2'});
	});

	test('refuse a persona without a name, with a look outside the lab’s range, or a color outside the catalog', async () => {
		const {handleCreatePersonaRoute} = routes;

		expect((await handleCreatePersonaRoute(request({}, {name: ' ', look, color: 'blue'}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleCreatePersonaRoute(request({}, {name: 'Finance', look: {...look, nose: 2}, color: 'blue'}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleCreatePersonaRoute(request({}, {name: 'Finance', look, color: 'brown'}))).unwrapErr().kind).toBe('parse_error');
		expect(store.createPersona).not.toHaveBeenCalled();
	});

	test('rename a persona or change its head, and delete one with every conversation, for whoever made it or owns the organization', async () => {
		const {handleDeletePersonaRoute, handleUpdatePersonaRoute} = routes;
		const changed = {name: 'Money', look: {...look, eyes: 1 as const}, color: 'green' as const};

		const updated = await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, changed));
		expect(store.updatePersona).toHaveBeenCalledWith('org-1', 'persona-1', changed);
		expect(updated.unwrap().persona).toEqual({...personaResponse, ...changed});

		store.getPersona.mockResolvedValue(Ok({...persona, createdById: 'user-2'}));
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
				{...persona, id: 'persona-3', chatModel: 'dropped-long-ago', lastMessage: null, draft: null},
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

	test('give the viewer’s conversation with the persona, begun through the built-in login where there was none, as turns alone, with whether the persona is busy or asleep', async () => {
		const {handleGetThreadRoute} = routes;
		const soon = new Date(Date.now() + 60_000);
		const base: Omit<JobRow, 'runAt'> = {id: 'j1', threadId: 'thread-1', kind: 'tool', status: 'queued', entryId: 'e1', callId: 'c1', claimedBy: null, attempts: 0};

		const idle = (await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap();
		expect(idle.persona).toEqual(personaResponse);
		expect(idle.entries).toEqual([{id: 'e1', kind: 'person', text: 'Hi', isError: false, at: '2026-10-21T10:00:00.000Z'}]);
		expect(idle).toMatchObject({busy: false, sleepingUntil: null, draft: null});
		expect(store.getThreadDraft).toHaveBeenCalledWith('thread-1');
		expect(store.ensureMemberThread).not.toHaveBeenCalled();
		expect(ensureBuiltInAgent).not.toHaveBeenCalled();

		store.getMemberThread.mockResolvedValue(Ok(null));
		store.listOpenJobs.mockResolvedValue(Ok([{...base, runAt: new Date(Date.now() - 1000)}]));
		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap()).toMatchObject({busy: true, sleepingUntil: null});
		expect(ensureBuiltInAgent).toHaveBeenCalledWith('org-1');
		expect(store.ensureMemberThread).toHaveBeenCalledWith({orgId: 'org-1', agentId: 'login-1', personaId: 'persona-1', userId: 'user-1'});

		store.listOpenJobs.mockResolvedValue(Ok([{...base, runAt: soon}]));
		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap()).toMatchObject({busy: false, sleepingUntil: soon.toISOString()});

		// A turn of the model to be tried again in a moment is work under way, not sleep.
		store.listOpenJobs.mockResolvedValue(Ok([{...base, kind: 'inference' as const, entryId: null, callId: null, runAt: soon}]));
		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap()).toMatchObject({busy: true, sleepingUntil: null});

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
