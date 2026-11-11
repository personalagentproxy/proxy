import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {ATTACHMENT_MARK} from '@proxy/utils/harness';

import type {HarnessBackend} from '@proxy/backends/harness/backend';
import {fakeHarness} from '@proxy/backends/harness/fake';
import type {EntryRow, JobRow, ThreadRow} from '@proxy/db/harness';

import type {HarnessRegistry} from '../backends/harness';
import type {ChatFiles} from './attachments';
import {type FakeStore, fakeStore} from './fake-store';

const viewer = {orgId: 'org-1', userId: 'user-1', slug: 'acme', name: 'Acme', role: 'member' as 'member' | 'owner', onboarded: true, experiments: ['harness']};
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

// A file as the log keeps it once attached, and as the page shows it.
const attached = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'pricing.md', type: 'text/markdown', size: 42, text: '# Pricing', cut: false};
const shownAttachment = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'pricing.md', type: 'text/markdown', size: 42, shown: false};

// Where a conversation's files are kept, as the routes are given it: a drive that has the one file.
const files = {
	upload: mock<ChatFiles['upload']>(async () => Ok(shownAttachment)),
	resolve: mock<ChatFiles['resolve']>(async (_viewer, refs) => (refs.every((ref) => ref.fileId === 'file-1') ? Ok(refs.map(() => attached)) : Err(ApiErr.notFound('file', 'file-2')))),
	shown: mock<ChatFiles['shown']>(() => shownAttachment),
};

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
	routes = (await import('./route')).chatRoutes(store, () => registry, files);
	store.listAttachments.mockResolvedValue(Ok([]));
	store.listDraftAttachments.mockResolvedValue(Ok([]));
	store.addDraftAttachment.mockResolvedValue(Ok(true));
	store.removeDraftAttachment.mockResolvedValue(Ok(true));
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
	listPersonas.mockResolvedValue(Ok([{...persona, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}, draft: null, draftAttachments: []}]));
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

	test('list the personas the viewer sees, their own and every member’s, with their heads, what runs each, whether the viewer may change each, and the last thing said with each and what the viewer typed and hasn’t sent, on one line, and the harnesses the server has with their models', async () => {
		const {handleListPersonasRoute} = routes;
		store.listPersonas.mockResolvedValue(
			Ok([
				{...persona, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}, draft: null, draftAttachments: []},
				{...persona, id: 'persona-3', ownerUserId: null, createdById: 'user-2', lastMessage: null, draft: 'Move the **pricing review**\nto Friday', draftAttachments: []},
				{
					...persona,
					id: 'persona-4',
					lastMessage: {kind: 'assistant', text: '## Found\n\n- **Three** invoices, see [the list](https://x.test)\n\n| Who | Sum |\n| --- | --- |\n| Dana | 40 |\n\n```\ncode\n```', createdAt: now},
					draft: null,
					draftAttachments: [],
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
		expect(listed).toEqual({personas: [{...personaResponse, id: 'persona-9', name: 'General', shared: true, mayChange: false}], harnesses: offered});
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
				{...persona, harness: 'claude-agent-sdk', chatModel: 'opus', lastMessage: null, draft: null, draftAttachments: []},
				{...persona, id: 'persona-3', ownerUserId: null, chatModel: 'dropped-long-ago', lastMessage: null, draft: null, draftAttachments: []},
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
		expect(idle.entries).toEqual([{id: 'e1', kind: 'person', text: 'Hi', isError: false, at: '2026-10-21T10:00:00.000Z', attachments: []}]);
		expect(idle).toMatchObject({busy: false, sleepingUntil: null, draft: null, draftAttachments: []});
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

	test('append the files the person attaches with what they say, as the drive has them then, or with nothing said; one they can’t read lands nothing', async () => {
		const {handlePostMessageRoute, handleGetThreadRoute} = routes;
		const ref = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1'};

		const posted = await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: 'What does this say?', attachments: [ref]}));
		expect(files.resolve).toHaveBeenCalledWith(viewer, [ref]);
		expect(store.appendPersonMessage).toHaveBeenCalledWith('thread-1', 'What does this say?', [attached]);
		expect(posted.unwrap().entry.attachments).toEqual([shownAttachment]);

		// A file alone is something said.
		expect((await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: '', attachments: [ref]}))).isOk()).toBe(true);
		expect(store.appendPersonMessage).toHaveBeenLastCalledWith('thread-1', '', [attached]);

		// A file sits where its mark is in the words; a mark beyond the files named is taken out,
		// and marks alone, with no file, are nothing said.
		const mark = ATTACHMENT_MARK;
		expect((await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: `Does ${mark} match ${mark}?`, attachments: [ref]}))).isOk()).toBe(true);
		expect(store.appendPersonMessage).toHaveBeenLastCalledWith('thread-1', `Does ${mark} match ?`, [attached]);
		expect((await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: ` ${mark} `}))).unwrapErr()).toEqual(ApiErr.validationError('Say something, or attach a file'));

		store.appendPersonMessage.mockClear();
		const refused = await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: 'And this?', attachments: [{...ref, fileId: 'file-2'}]}));
		expect(refused.unwrapErr()).toMatchObject({kind: 'not_found', resource: 'file'});
		expect(store.appendPersonMessage).not.toHaveBeenCalled();
		expect((await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: 'Too many', attachments: Array.from({length: 11}, () => ref)}))).unwrapErr().kind).toBe('parse_error');

		// The conversation shows each file with the turn it was said with.
		store.listAttachments.mockResolvedValue(Ok([{...attached, entryId: 'e1'}]));
		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap().entries.map((entry) => entry.attachments)).toEqual([[shownAttachment]]);
	});

	test('keep a file put in the conversation’s input in the person’s drive and in the input, where it waits with what they typed; a full input takes no more', async () => {
		const {handleUploadAttachmentRoute, handleGetThreadRoute, handleListPersonasRoute} = routes;
		const {shown: _shown, ...kept} = shownAttachment;

		const uploaded = await handleUploadAttachmentRoute(request({personaId: 'persona-1'}));

		expect(uploaded.unwrap()).toEqual({attachment: shownAttachment});
		expect(files.upload).toHaveBeenCalledWith(viewer, persona, expect.anything());
		expect(store.addDraftAttachment).toHaveBeenCalledWith('thread-1', kept, 10);

		// The conversation opens with it there, and the list says it is waiting where nothing was typed.
		store.listDraftAttachments.mockResolvedValue(Ok([kept]));
		expect((await handleGetThreadRoute(request({personaId: 'persona-1'}))).unwrap().draftAttachments).toEqual([shownAttachment]);
		store.listPersonas.mockResolvedValue(Ok([{...persona, lastMessage: null, draft: null, draftAttachments: [kept, {...kept, fileId: 'file-2', name: 'chart.png'}]}]));
		expect((await handleListPersonasRoute(request())).unwrap().personas[0]?.draft).toBe('pricing.md, chart.png');
		store.listPersonas.mockResolvedValue(Ok([{...persona, lastMessage: null, draft: 'Book the train', draftAttachments: [kept]}]));
		expect((await handleListPersonasRoute(request())).unwrap().personas[0]?.draft).toBe('Book the train');

		// With as many there as a message carries, the next is refused before its bytes are taken.
		files.upload.mockClear();
		store.listDraftAttachments.mockResolvedValue(Ok(Array.from({length: 10}, () => kept)));
		expect((await handleUploadAttachmentRoute(request({personaId: 'persona-1'}))).unwrapErr()).toEqual(ApiErr.conflict('A message carries at most 10 files.'));
		expect(files.upload).not.toHaveBeenCalled();

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleUploadAttachmentRoute(request({personaId: 'nope'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'persona'});
	});

	test('take a file out of the conversation’s input, by where it is and the version it held', async () => {
		const {handleRemoveAttachmentRoute} = routes;
		const file = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1'};

		expect((await handleRemoveAttachmentRoute(request({personaId: 'persona-1'}, file))).isOk()).toBe(true);
		expect(store.removeDraftAttachment).toHaveBeenCalledWith('thread-1', file);
		expect((await handleRemoveAttachmentRoute(request({personaId: 'persona-1'}, {fileId: 'file-1'}))).unwrapErr().kind).toBe('parse_error');
	});

	test('append what the person says, trimmed, and refuse nothing or too much', async () => {
		const {handlePostMessageRoute} = routes;

		const posted = await handlePostMessageRoute(request({personaId: 'persona-1'}, {text: '  Hello \n'}));
		expect(store.appendPersonMessage).toHaveBeenCalledWith('thread-1', 'Hello', []);
		expect(posted.unwrap().entry).toMatchObject({id: 'e3', kind: 'person', text: 'Hello', attachments: []});
		expect(files.resolve).not.toHaveBeenCalled();

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
		expect(store.saveThreadDraft).toHaveBeenLastCalledWith('thread-1', '  Move the pricing review\n', undefined);

		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: ' \n '}))).isOk()).toBe(true);
		expect(store.saveThreadDraft).toHaveBeenLastCalledWith('thread-1', null, undefined);

		// Where files sit among the words, the save says which file each mark is, in their order.
		const order = [
			{connectionId: 'drive-1', fileId: 'file-2', version: 'v1'},
			{connectionId: 'drive-1', fileId: 'file-1', version: 'v1'},
		];
		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: `Does ${ATTACHMENT_MARK} match ${ATTACHMENT_MARK}?`, attachments: order}))).isOk()).toBe(true);
		expect(store.saveThreadDraft).toHaveBeenLastCalledWith('thread-1', `Does ${ATTACHMENT_MARK} match ${ATTACHMENT_MARK}?`, order);

		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: 'x'.repeat(20_001)}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {}))).unwrapErr().kind).toBe('parse_error');

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleSaveDraftRoute(request({personaId: 'persona-9'}, {text: 'Hi'}))).unwrapErr().kind).toBe('not_found');
		expect(store.saveThreadDraft).toHaveBeenCalledTimes(3);
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
