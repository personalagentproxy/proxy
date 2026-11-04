import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';

import type {EntryRow, JobRow, ThreadRow} from '@proxy/db/harness';

import {type FakeStore, fakeStore} from './fake-store';

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['harness'], insider: false};
const requireViewer = mock(async () => Ok(viewer));
mock.module('../utils/user-org', () => ({requireViewer}));

const ensureBuiltInAgent = mock(async () => Ok({id: 'login-1'}));
mock.module('./built-in-agent', () => ({ensureBuiltInAgent}));

const now = new Date('2026-10-21T10:00:00Z');
const look = {nose: 0.48, noseOut: 0.35, eye: 27, eyeTheta: 55, eyeLat: 8, eyes: 2 as const};
const persona = {id: 'persona-1', name: 'Finance', look, color: 'blue', chatModel: 'claude' as 'claude' | 'glm', createdById: 'user-1'};
const personaResponse = {id: 'persona-1', name: 'Finance', look, color: 'blue' as const, chatModel: null, mayChange: true, lastMessage: null};
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
		jobId: null,
		createdAt: now,
		...entry,
	};
}

beforeEach(async () => {
	mock.clearAllMocks();
	store = fakeStore();
	routes = (await import('./route')).chatRoutes(store);
	const {listPersonas, getPersona, createPersona, updatePersona, deletePersona, getMemberThread, ensureMemberThread, listShownEntries, listOpenJobs, appendPersonMessage} = store;
	deletePersona.mockResolvedValue(Ok(true));
	requireViewer.mockResolvedValue(Ok(viewer));
	listPersonas.mockResolvedValue(Ok([{...persona, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}}]));
	getPersona.mockResolvedValue(Ok(persona));
	createPersona.mockResolvedValue(Ok({...persona, id: 'persona-2'}));
	updatePersona.mockResolvedValue(Ok(true));
	getMemberThread.mockResolvedValue(Ok(thread));
	ensureMemberThread.mockResolvedValue(Ok(thread));
	listShownEntries.mockResolvedValue(
		Ok([logEntry({id: 'e1', seq: 1, kind: 'person', text: 'Hi'}), logEntry({id: 'e2', seq: 2, kind: 'summary', text: 'The person said hi.', inputTokens: 90_000, outputTokens: 10, coversSeq: 1})]),
	);
	listOpenJobs.mockResolvedValue(Ok([]));
	appendPersonMessage.mockResolvedValue(Ok(logEntry({id: 'e3', seq: 3, kind: 'person', text: 'Hello'})));
});

describe('the chat routes', () => {
	test('are refused without the experiment', async () => {
		const {handleListPersonasRoute, handlePostMessageRoute} = routes;
		requireViewer.mockResolvedValue(Ok({...viewer, experiments: []}));

		expect((await handleListPersonasRoute(request())).unwrapErr().kind).toBe('forbidden');
		expect((await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: 'Hi'}))).unwrapErr().kind).toBe('forbidden');
		expect(store.appendPersonMessage).not.toHaveBeenCalled();
	});

	test('list the organization’s personas, with their heads, whether the viewer may change each, and the last thing said with each, on one line', async () => {
		const {handleListPersonasRoute} = routes;
		store.listPersonas.mockResolvedValue(
			Ok([
				{...persona, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}},
				{...persona, id: 'persona-3', createdById: 'user-2', lastMessage: null},
				{
					...persona,
					id: 'persona-4',
					lastMessage: {kind: 'assistant', text: '## Found\n\n- **Three** invoices, see [the list](https://x.test)\n\n| Who | Sum |\n| --- | --- |\n| Dana | 40 |\n\n```\ncode\n```', createdAt: now},
				},
			]),
		);

		const listed = (await handleListPersonasRoute(request())).unwrap();

		expect(store.listPersonas).toHaveBeenCalledWith('org-1', 'user-1');
		expect(listed).toEqual({
			personas: [
				{...personaResponse, lastMessage: {kind: 'assistant', text: 'Your vault has one entry.', at: '2026-10-21T10:00:00.000Z'}},
				{...personaResponse, id: 'persona-3', mayChange: false},
				{...personaResponse, id: 'persona-4', lastMessage: {kind: 'assistant', text: 'Found Three invoices, see the list Who Sum Dana 40', at: '2026-10-21T10:00:00.000Z'}},
			],
		});
	});

	test('an organization without a persona gets a General one, nobody’s, on its first listing', async () => {
		const {handleListPersonasRoute} = routes;
		store.listPersonas.mockResolvedValue(Ok([]));
		store.ensureFirstPersona.mockResolvedValue(Ok({...persona, id: 'persona-9', name: 'General', createdById: null}));

		const listed = (await handleListPersonasRoute(request())).unwrap();

		expect(store.ensureFirstPersona).toHaveBeenCalledWith('org-1');
		expect(listed).toEqual({personas: [{...personaResponse, id: 'persona-9', name: 'General', mayChange: false}]});
	});

	test('make a persona as given, for everyone in the organization, with the organization’s built-in login where there is none', async () => {
		const {handleCreatePersonaRoute} = routes;

		const made = await handleCreatePersonaRoute(request({}, {name: ' Finance ', look, color: 'blue'}));

		expect(ensureBuiltInAgent).toHaveBeenCalledWith('org-1');
		expect(store.createPersona).toHaveBeenCalledWith('org-1', 'user-1', {name: 'Finance', look, color: 'blue'});
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

	test('in an insider organization, make a persona with the model chosen, switch it to another, and show which it answers with', async () => {
		const {handleCreatePersonaRoute, handleListPersonasRoute, handleUpdatePersonaRoute} = routes;
		requireViewer.mockResolvedValue(Ok({...viewer, insider: true}));
		store.createPersona.mockResolvedValue(Ok({...persona, id: 'persona-2', chatModel: 'glm'}));

		const made = await handleCreatePersonaRoute(request({}, {name: 'Finance', look, color: 'blue', chatModel: 'glm'}));
		expect(store.createPersona).toHaveBeenCalledWith('org-1', 'user-1', {name: 'Finance', look, color: 'blue', chatModel: 'glm'});
		expect(made.unwrap().persona).toEqual({...personaResponse, id: 'persona-2', chatModel: 'glm'});

		const switched = await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, {name: 'Finance', look, color: 'blue', chatModel: 'glm'}));
		expect(store.updatePersona).toHaveBeenCalledWith('org-1', 'persona-1', {name: 'Finance', look, color: 'blue', chatModel: 'glm'});
		expect(switched.unwrap().persona.chatModel).toBe('glm');

		// Left out, a persona changed keeps its own.
		const renamed = await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, {name: 'Money', look, color: 'blue'}));
		expect(store.updatePersona).toHaveBeenLastCalledWith('org-1', 'persona-1', {name: 'Money', look, color: 'blue'});
		expect(renamed.unwrap().persona.chatModel).toBe('claude');

		expect((await handleListPersonasRoute(request())).unwrap().personas[0]?.chatModel).toBe('claude');
		expect((await handleCreatePersonaRoute(request({}, {name: 'Finance', look, color: 'blue', chatModel: 'gpt'}))).unwrapErr().kind).toBe('parse_error');
	});

	test('outside an insider organization, ignore a model chosen, and show none', async () => {
		const {handleCreatePersonaRoute, handleUpdatePersonaRoute} = routes;
		store.createPersona.mockResolvedValue(Ok({...persona, id: 'persona-2', chatModel: 'glm'}));

		const made = await handleCreatePersonaRoute(request({}, {name: 'Finance', look, color: 'blue', chatModel: 'glm'}));
		expect(store.createPersona).toHaveBeenCalledWith('org-1', 'user-1', {name: 'Finance', look, color: 'blue'});
		expect(made.unwrap().persona.chatModel).toBeNull();

		await handleUpdatePersonaRoute(request({personaId: 'persona-1'}, {name: 'Finance', look, color: 'blue', chatModel: 'glm'}));
		expect(store.updatePersona).toHaveBeenCalledWith('org-1', 'persona-1', {name: 'Finance', look, color: 'blue'});
	});

	test('give the viewer’s conversation with the persona, begun through the built-in login where there was none, as turns alone, with whether the persona is busy or asleep', async () => {
		const {handleGetThreadRoute} = routes;
		const soon = new Date(Date.now() + 60_000);
		const base: Omit<JobRow, 'runAt'> = {id: 'j1', threadId: 'thread-1', kind: 'tool', status: 'queued', entryId: 'e1', callId: 'c1', claimedBy: null, attempts: 0};

		const idle = (await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap();
		expect(idle.persona).toEqual(personaResponse);
		expect(idle.entries).toEqual([{id: 'e1', kind: 'person', text: 'Hi', isError: false, at: '2026-10-21T10:00:00.000Z'}]);
		expect(idle).toMatchObject({busy: false, sleepingUntil: null});
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
});
