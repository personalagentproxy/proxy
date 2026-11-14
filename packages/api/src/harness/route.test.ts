import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';

import {ApiErr} from '@proxy/utils';
import {ATTACHMENT_MARK} from '@proxy/utils/harness';

import type {HarnessBackend} from '@proxy/backends/harness/backend';
import {fakeHarness} from '@proxy/backends/harness/fake';
import type {ChatThreadRow, EntryRow, ThreadRow} from '@proxy/db/harness';

import type {HarnessRegistry} from '../backends/harness';
import type {ChatFiles} from './attachments';
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
// The viewer's chat with the persona.
const chat: ThreadRow = {
	id: 'chat-1',
	orgId: 'org-1',
	agentId: 'login-1',
	personaId: 'persona-1',
	userId: 'user-1',
	parentThreadId: null,
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
const shownAttachment = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'pricing.md', type: 'text/markdown', size: 42, shown: false, gone: false};

// Where a chat's files are kept, as the routes are given it: a drive that has the one file.
const files = {
	upload: mock<ChatFiles['upload']>(async () => Ok(shownAttachment)),
	discard: mock<ChatFiles['discard']>(async () => Ok(undefined)),
	resolve: mock<ChatFiles['resolve']>(async (_viewer, refs) => (refs.every((ref) => ref.fileId === 'file-1') ? Ok(refs.map(() => attached)) : Err(ApiErr.notFound('file', 'file-2')))),
	shown: mock<ChatFiles['shown']>(() => shownAttachment),
};

// An entry of the log, as the store gives it.
function logEntry(entry: Pick<EntryRow, 'id' | 'seq' | 'kind' | 'text'> & Partial<EntryRow>): EntryRow {
	return {
		threadId: 'chat-1',
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

// A call the model made, its arguments as JSON.
function call(id: string, name: string, args: Record<string, string>) {
	return {id, name, arguments: JSON.stringify(args)};
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
	const {listPersonas, ensureFirstPersona, getPersona, createPersona, updatePersona, deletePersona, getMemberChat, ensureMemberChat, getChatDraft} = store;
	deletePersona.mockResolvedValue(Ok(true));
	ensureFirstPersona.mockResolvedValue(Ok({...persona, id: 'persona-9', name: 'General', ownerUserId: null, createdById: null}));
	requireViewer.mockResolvedValue(Ok(viewer));
	listPersonas.mockResolvedValue(Ok([{...persona, lastMessage: {kind: 'assistant', text: 'Your vault\n has  one entry.', createdAt: now}, draft: null, draftAttachments: []}]));
	getPersona.mockResolvedValue(Ok(persona));
	createPersona.mockResolvedValue(Ok({...persona, id: 'persona-2'}));
	updatePersona.mockResolvedValue(Ok(true));
	getMemberChat.mockResolvedValue(Ok(chat));
	ensureMemberChat.mockResolvedValue(Ok(chat));
	getChatDraft.mockResolvedValue(Ok(null));
	store.listChatThreads.mockResolvedValue(Ok([]));
});

describe('the chat routes', () => {
	test('offer OpenRouter only with the openrouter experiment: without it, a persona on it is shown on Claude, and none is made or switched to it', async () => {
		const {handleCreatePersonaRoute, handleListPersonasRoute, handleUpdatePersonaRoute} = routes;
		requireViewer.mockResolvedValue(Ok({...viewer, experiments: []}));
		store.listPersonas.mockResolvedValue(Ok([{...persona, ownerUserId: null, lastMessage: null, draft: null, draftAttachments: []}]));

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

	test('list the persona’s last answer in each of the viewer’s chats, on one line, and whether it is unread, making nothing', async () => {
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

	test('rename a persona or change its head, and delete one with every chat, for whose it is, and of one every member sees, for whoever made it or owns the organization', async () => {
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

	test('keep a file put in the chat’s input in the person’s drive and in the input, where it waits with what they typed; a full input takes no more', async () => {
		const {handleUploadAttachmentRoute, handleListThreadsRoute, handleListPersonasRoute} = routes;
		const {shown: _shown, gone: _gone, ...kept} = shownAttachment;

		const uploaded = await handleUploadAttachmentRoute(request({personaId: 'persona-1'}));

		expect(uploaded.unwrap()).toEqual({attachment: shownAttachment});
		expect(files.upload).toHaveBeenCalledWith(viewer, persona, expect.anything());
		expect(store.addDraftAttachment).toHaveBeenCalledWith('chat-1', kept, 10);

		// The chat opens with it there, and the list says it is waiting where nothing was typed.
		store.listDraftAttachments.mockResolvedValue(Ok([kept]));
		expect((await handleListThreadsRoute(request({personaId: 'persona-1'}))).unwrap().draftAttachments).toEqual([shownAttachment]);
		store.listPersonas.mockResolvedValue(Ok([{...persona, lastMessage: null, draft: null, draftAttachments: [kept, {...kept, fileId: 'file-2', name: 'chart.png'}]}]));
		expect((await handleListPersonasRoute(request())).unwrap().personas[0]?.draft).toBe('pricing.md, chart.png');
		store.listPersonas.mockResolvedValue(Ok([{...persona, lastMessage: null, draft: 'Book the train', draftAttachments: [kept]}]));
		expect((await handleListPersonasRoute(request())).unwrap().personas[0]?.draft).toBe('Book the train');

		// With as many there as a message carries, the next is refused before its bytes are taken.
		files.upload.mockClear();
		store.listDraftAttachments.mockResolvedValue(Ok(Array.from({length: 10}, () => kept)));
		expect((await handleUploadAttachmentRoute(request({personaId: 'persona-1'}))).unwrapErr()).toEqual(ApiErr.conflict('A message carries at most 10 files.'));
		expect(files.upload).not.toHaveBeenCalled();

		// Filled by another upload while this one's bytes came, the input refuses it, and the file goes from the drive again.
		expect(files.discard).not.toHaveBeenCalled();
		store.listDraftAttachments.mockResolvedValue(Ok([kept]));
		store.addDraftAttachment.mockResolvedValue(Err(ApiErr.conflict('A message carries at most 10 files.')));
		expect((await handleUploadAttachmentRoute(request({personaId: 'persona-1'}))).unwrapErr()).toEqual(ApiErr.conflict('A message carries at most 10 files.'));
		expect(files.discard).toHaveBeenCalledWith(viewer, shownAttachment);

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleUploadAttachmentRoute(request({personaId: 'nope'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'persona'});
	});

	test('take a file out of the chat’s input, by where it is and the version it held', async () => {
		const {handleRemoveAttachmentRoute} = routes;
		const file = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1'};

		expect((await handleRemoveAttachmentRoute(request({personaId: 'persona-1'}, file))).isOk()).toBe(true);
		expect(store.removeDraftAttachment).toHaveBeenCalledWith('chat-1', file);
		expect((await handleRemoveAttachmentRoute(request({personaId: 'persona-1'}, {fileId: 'file-1'}))).unwrapErr().kind).toBe('parse_error');
	});

	test('keep what the viewer typed and hasn’t sent as it is, forget nothing but whitespace, and refuse too much', async () => {
		const {handleSaveDraftRoute} = routes;
		store.saveChatDraft.mockResolvedValue(Ok(true));

		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: '  Move the pricing review\n'}))).isOk()).toBe(true);
		expect(store.saveChatDraft).toHaveBeenLastCalledWith('chat-1', '  Move the pricing review\n', undefined);

		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: ' \n '}))).isOk()).toBe(true);
		expect(store.saveChatDraft).toHaveBeenLastCalledWith('chat-1', null, undefined);

		// Where files sit among the words, the save says which file each mark is, in their order.
		const order = [
			{connectionId: 'drive-1', fileId: 'file-2', version: 'v1'},
			{connectionId: 'drive-1', fileId: 'file-1', version: 'v1'},
		];
		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: `Does ${ATTACHMENT_MARK} match ${ATTACHMENT_MARK}?`, attachments: order}))).isOk()).toBe(true);
		expect(store.saveChatDraft).toHaveBeenLastCalledWith('chat-1', `Does ${ATTACHMENT_MARK} match ${ATTACHMENT_MARK}?`, order);

		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {text: 'x'.repeat(20_001)}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleSaveDraftRoute(request({personaId: 'persona-1'}, {}))).unwrapErr().kind).toBe('parse_error');

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleSaveDraftRoute(request({personaId: 'persona-9'}, {text: 'Hi'}))).unwrapErr().kind).toBe('not_found');
		expect(store.saveChatDraft).toHaveBeenCalledTimes(3);
	});

	test('mark the viewer’s chat with the persona read up to the answer shown, in any of its threads, beginning none, and say where the answer, the chat or the persona is gone', async () => {
		const {handleMarkReadRoute} = routes;
		store.markChatRead.mockResolvedValue(Ok(true));

		expect((await handleMarkReadRoute(request({personaId: 'persona-1'}, {entryId: 'e9'}))).isOk()).toBe(true);
		expect(store.markChatRead).toHaveBeenCalledWith('chat-1', 'e9');

		expect((await handleMarkReadRoute(request({personaId: 'persona-1'}, {}))).unwrapErr().kind).toBe('parse_error');

		store.markChatRead.mockResolvedValue(Ok(false));
		expect((await handleMarkReadRoute(request({personaId: 'persona-1'}, {entryId: 'elsewhere'}))).unwrapErr().kind).toBe('not_found');

		store.getMemberChat.mockResolvedValue(Ok(null));
		expect((await handleMarkReadRoute(request({personaId: 'persona-1'}, {entryId: 'e9'}))).unwrapErr().kind).toBe('not_found');
		expect(store.ensureMemberChat).not.toHaveBeenCalled();
		expect(ensureBuiltInAgent).not.toHaveBeenCalled();

		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleMarkReadRoute(request({personaId: 'persona-9'}, {entryId: 'e9'}))).unwrapErr().kind).toBe('not_found');
		expect(store.markChatRead).toHaveBeenCalledTimes(2);
	});
});

describe('the chat’s threads', () => {
	const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

	// A thread of the viewer's chat, its message opening it, stopped unless the test says otherwise.
	function chatThread(row: Partial<ChatThreadRow> & {id: string}): ChatThreadRow {
		return {
			...chat,
			startedFromThreadId: null,
			titleWritten: false,
			parentThreadId: 'chat-1',
			title: 'Pricing review with Dana',
			taskId: 'task-1',
			state: {kind: 'stopped'},
			standing: {waitingForMember: false, summary: null, summarySeq: null, archived: false},
			entries: [],
			attachments: [],
			...row,
		};
	}

	const review = chatThread({
		id: 'thread-2',
		taskId: 'task-2',
		entries: [
			logEntry({id: 'e1', seq: 1, threadId: 'thread-2', kind: 'person', text: 'Find the pricing review with Dana'}),
			logEntry({
				id: 'e2',
				seq: 2,
				threadId: 'thread-2',
				kind: 'assistant',
				text: '',
				toolCalls: [call('c1', 'send_to_person', {text: 'Looking through the shared drive.'}), call('c2', 'script', {code: 'return 1'})],
				createdAt: later(1),
			}),
			logEntry({id: 'e3', seq: 4, threadId: 'thread-2', kind: 'assistant', text: 'It moved to **Friday**, with the new prices attached.', createdAt: later(2)}),
		],
		attachments: [{...attached, entryId: 'e1', gone: false}],
	});
	const watch = chatThread({
		id: 'thread-3',
		title: 'Tell me when Dana writes',
		createdAt: later(-10),
		state: {kind: 'asleep', until: later(60)},
		entries: [logEntry({id: 'e4', seq: 3, threadId: 'thread-3', kind: 'event', text: 'The alert “Dana” matched a new one of the emails.', createdAt: later(30)})],
	});

	beforeEach(() => {
		store.listChatThreads.mockResolvedValue(Ok([watch, review]));
		store.getChatThread.mockResolvedValue(Ok(review));
		store.openThread.mockResolvedValue(Ok({thread: review, entry: logEntry({id: 'e1', seq: 1, threadId: 'thread-2', kind: 'person', text: 'Find the pricing review with Dana'})}));
		store.replyInThread.mockResolvedValue(Ok(logEntry({id: 'e5', seq: 5, threadId: 'thread-2', kind: 'person', text: 'And the old prices?'})));
	});

	test('list the chat, begun where there was none, with its draft and its threads in the order they were opened, the newest last, whichever last had a message: what is up with each, what opened it, the start of the latest thing said in it, and how many messages it holds', async () => {
		const {handleListThreadsRoute} = routes;
		store.getMemberChat.mockResolvedValue(Ok(null));
		store.getChatDraft.mockResolvedValue(Ok('Move the review'));
		store.listDraftAttachments.mockResolvedValue(Ok([{connectionId: 'drive-1', fileId: 'file-1', version: 'v1', name: 'pricing.md', type: 'text/markdown', size: 42}]));

		const listed = (await handleListThreadsRoute(request({personaId: 'persona-1'}))).unwrap();

		expect(store.ensureMemberChat).toHaveBeenCalledWith({orgId: 'org-1', agentId: 'login-1', personaId: 'persona-1', userId: 'user-1'});
		expect(store.listChatThreads).toHaveBeenCalledWith('chat-1', ['send_to_person'], expect.any(Date));
		expect(listed.persona).toEqual(personaResponse);
		expect(listed.draft).toBe('Move the review');
		expect(listed.draftAttachments).toEqual([shownAttachment]);
		expect(listed.threads).toEqual([
			{
				id: 'thread-3',
				title: 'Tell me when Dana writes',
				state: {kind: 'asleep', until: later(60).toISOString()},
				standing: 'in_progress',
				standingPending: false,
				opener: {kind: 'event', text: 'The alert “Dana” matched a new one of the emails.'},
				summary: null,
				latest: null,
				latestEntryId: null,
				latestAnswerId: null,
				startedByAgent: false,
				titled: false,
				messageCount: 1,
				lastMessageAt: later(30).toISOString(),
				createdAt: later(-10).toISOString(),
			},
			{
				id: 'thread-2',
				title: 'Pricing review with Dana',
				state: {kind: 'stopped'},
				standing: 'done',
				standingPending: false,
				opener: {kind: 'person', text: 'Find the pricing review with Dana', attachments: [shownAttachment]},
				summary: null,
				latest: 'It moved to Friday, with the new prices attached.',
				latestEntryId: 'e3',
				latestAnswerId: 'e3',
				startedByAgent: false,
				titled: false,
				messageCount: 3,
				lastMessageAt: later(2).toISOString(),
				createdAt: now.toISOString(),
			},
		]);
	});

	test('say where each thread stands: in progress while at work or asleep, waiting for the viewer where its turn’s end said so, done otherwise; and its summary only while nothing was said past it', async () => {
		const {handleListThreadsRoute, handleGetChatThreadRoute} = routes;
		store.getChatDraft.mockResolvedValue(Ok(null));
		store.listDraftAttachments.mockResolvedValue(Ok([]));
		const waiting = {...review, standing: {waitingForMember: true, summary: 'Found it, and asks whether to send the new prices to Dana.', summarySeq: 4, archived: false}};
		const stale = chatThread({
			id: 'thread-4',
			standing: {waitingForMember: false, summary: 'Booked the room for Friday.', summarySeq: 2, archived: false},
			entries: [
				logEntry({id: 'e7', seq: 1, threadId: 'thread-4', kind: 'person', text: 'Book a room for the review'}),
				logEntry({id: 'e8', seq: 2, threadId: 'thread-4', kind: 'assistant', text: 'Booked the Lindens room for Friday.'}),
				logEntry({id: 'e9', seq: 7, threadId: 'thread-4', kind: 'person', text: 'Make it Thursday', createdAt: later(5)}),
			],
		});
		// Asleep, a summary written before it slept is still current: nothing was said since.
		const sleeping = {...watch, standing: {waitingForMember: false, summary: 'Watches for an email from Dana.', summarySeq: 3, archived: false}};
		store.listChatThreads.mockResolvedValue(Ok([waiting, stale, sleeping]));

		const listed = (await handleListThreadsRoute(request({personaId: 'persona-1'}))).unwrap().threads;

		expect(listed.map(({id, standing, summary, latest}) => ({id, standing, summary, latest}))).toEqual([
			{id: 'thread-3', standing: 'in_progress', summary: 'Watches for an email from Dana.', latest: null},
			{id: 'thread-2', standing: 'waiting', summary: 'Found it, and asks whether to send the new prices to Dana.', latest: 'It moved to Friday, with the new prices attached.'},
			{id: 'thread-4', standing: 'done', summary: null, latest: 'Booked the Lindens room for Friday.'},
		]);

		// At work again, it is in progress whatever its last turn's end said; what the viewer said,
		// still pending, makes the summary stale.
		const reply = {...logEntry({id: 'e10', seq: 3, threadId: 'thread-2', kind: 'person', text: 'Yes, send them'}), pending: true};
		store.getChatThread.mockResolvedValue(Ok({...waiting, state: {kind: 'working'}, entries: [...waiting.entries, reply]}));
		expect((await handleGetChatThreadRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).unwrap().thread).toMatchObject({standing: 'in_progress', summary: null});
	});

	test('say that where a thread stands is still being read while it stopped a moment ago with nothing written for what was said last, and not once it is written, later, or at work', async () => {
		const {handleListThreadsRoute} = routes;
		store.getChatDraft.mockResolvedValue(Ok(null));
		store.listDraftAttachments.mockResolvedValue(Ok([]));
		const ago = (seconds: number) => new Date(Date.now() - seconds * 1000);
		const ended = (id: string, seconds: number, row: Partial<ChatThreadRow> = {}) =>
			chatThread({
				id,
				entries: [
					logEntry({id: `${id}-1`, seq: 1, threadId: id, kind: 'person', text: 'Book a room for the review', createdAt: ago(seconds + 30)}),
					logEntry({id: `${id}-2`, seq: 2, threadId: id, kind: 'assistant', text: 'Which day?', createdAt: ago(seconds)}),
				],
				...row,
			});
		store.listChatThreads.mockResolvedValue(
			Ok([
				ended('just-stopped', 2),
				// One from before its last turn is as good as none.
				ended('stale', 2, {standing: {waitingForMember: false, summary: 'Asked for a room.', summarySeq: 1, archived: false}}),
				ended('written', 2, {standing: {waitingForMember: true, summary: 'Asks which day.', summarySeq: 2, archived: false}}),
				// Written with no sentence, it is written all the same.
				ended('written-bare', 2, {standing: {waitingForMember: false, summary: null, summarySeq: 2, archived: false}}),
				ended('long-stopped', 600),
				ended('working', 2, {state: {kind: 'working'}}),
				chatThread({id: 'empty'}),
			]),
		);

		const listed = (await handleListThreadsRoute(request({personaId: 'persona-1'}))).unwrap().threads;

		expect(Object.fromEntries(listed.map((thread) => [thread.id, thread.standingPending]))).toEqual({
			'just-stopped': true,
			stale: true,
			written: false,
			'written-bare': false,
			'long-stopped': false,
			working: false,
			empty: false,
		});
	});

	test('mark a thread of the viewer’s chat done, and say where there is no such thread', async () => {
		const {handleMarkThreadDoneRoute} = routes;
		store.markThreadDone.mockResolvedValue(Ok(true));

		expect((await handleMarkThreadDoneRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).isOk()).toBe(true);
		expect(store.markThreadDone).toHaveBeenCalledWith('chat-1', 'thread-2');

		store.markThreadDone.mockResolvedValue(Ok(false));
		expect((await handleMarkThreadDoneRoute(request({personaId: 'persona-1', threadId: 'thread-9'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});

		store.getMemberChat.mockResolvedValue(Ok(null));
		expect((await handleMarkThreadDoneRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});
		store.getPersona.mockResolvedValue(Ok(null));
		expect((await handleMarkThreadDoneRoute(request({personaId: 'persona-9', threadId: 'thread-2'}))).unwrapErr().kind).toBe('not_found');
		expect(store.markThreadDone).toHaveBeenCalledTimes(2);
		expect(store.ensureMemberChat).not.toHaveBeenCalled();
	});

	test('archive a thread of the viewer’s chat, and say where there is no such thread', async () => {
		const {handleArchiveThreadRoute} = routes;
		store.archiveThread.mockResolvedValue(Ok(true));

		expect((await handleArchiveThreadRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).isOk()).toBe(true);
		expect(store.archiveThread).toHaveBeenCalledWith('chat-1', 'thread-2');

		store.archiveThread.mockResolvedValue(Ok(false));
		expect((await handleArchiveThreadRoute(request({personaId: 'persona-1', threadId: 'thread-9'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});

		store.getMemberChat.mockResolvedValue(Ok(null));
		expect((await handleArchiveThreadRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});
		expect(store.archiveThread).toHaveBeenCalledTimes(2);
		expect(store.ensureMemberChat).not.toHaveBeenCalled();
	});

	test('give one thread with its messages: what the person said with their files, what the persona answered and told them as it went, and events, without the calls', async () => {
		const {handleGetChatThreadRoute} = routes;
		store.getChatThread.mockResolvedValue(Ok({...review, state: {kind: 'working'}}));

		const view = (await handleGetChatThreadRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).unwrap();

		expect(store.getChatThread).toHaveBeenCalledWith('chat-1', 'thread-2', ['send_to_person'], expect.any(Date));
		expect(view.busy).toBe(true);
		expect(view.thread).toMatchObject({id: 'thread-2', state: {kind: 'working'}, messageCount: 3});
		expect(view.messages).toEqual([
			{id: 'e1', kind: 'person', text: 'Find the pricing review with Dana', isError: false, at: now.toISOString(), attachments: [shownAttachment]},
			{id: 'e2:c1', kind: 'assistant', text: 'Looking through the shared drive.', isError: false, at: later(1).toISOString(), attachments: []},
			{id: 'e3', kind: 'assistant', text: 'It moved to **Friday**, with the new prices attached.', isError: false, at: later(2).toISOString(), attachments: []},
		]);

		// What it told the person last, mid-turn, is its latest line; its latest answer is still the one before.
		const told = logEntry({
			id: 'e6',
			seq: 6,
			threadId: 'thread-2',
			kind: 'assistant',
			text: '',
			toolCalls: [call('c3', 'send_to_person', {text: 'Checking the old prices too.'})],
			createdAt: later(3),
		});
		store.getChatThread.mockResolvedValue(Ok({...review, entries: [...review.entries, told]}));
		expect((await handleGetChatThreadRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).unwrap().thread).toMatchObject({
			latest: 'Checking the old prices too.',
			latestEntryId: 'e6',
			latestAnswerId: 'e3',
		});

		store.getChatThread.mockResolvedValue(Ok(watch));
		expect((await handleGetChatThreadRoute(request({personaId: 'persona-1', threadId: 'thread-3'}))).unwrap().messages.map((message) => message.kind)).toEqual(['event']);

		store.getChatThread.mockResolvedValue(Ok(null));
		expect((await handleGetChatThreadRoute(request({personaId: 'persona-1', threadId: 'thread-9'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});
		store.getMemberChat.mockResolvedValue(Ok(null));
		expect((await handleGetChatThreadRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});
		expect(store.ensureMemberChat).not.toHaveBeenCalled();
	});

	test('open a thread with what the viewer says, trimmed, and the files they attach, titled with a line of it, and answer with the thread', async () => {
		const {handleOpenThreadRoute} = routes;
		const ref = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1'};

		const opened = (await handleOpenThreadRoute(request({personaId: 'persona-1'}, {text: ' Find the pricing review with Dana \n', attachments: [ref]}))).unwrap();

		expect(store.openThread).toHaveBeenCalledWith(
			'chat-1',
			'Find the pricing review with Dana',
			{
				title: 'Find the pricing review with Dana',
				task: {
					orgId: 'org-1',
					agentId: 'login-1',
					ownerUserId: 'user-1',
					personaId: 'persona-1',
					parentId: null,
					title: 'Find the pricing review with Dana',
					goal: 'Find the pricing review with Dana',
					via: 'harness',
				},
			},
			[attached],
		);
		expect(store.getChatThread).toHaveBeenCalledWith('chat-1', 'thread-2', ['send_to_person'], expect.any(Date));
		expect(opened.thread).toMatchObject({id: 'thread-2', title: 'Pricing review with Dana'});

		// With files alone, titled by their names.
		await handleOpenThreadRoute(request({personaId: 'persona-1'}, {text: '', attachments: [ref]}));
		expect(store.openThread).toHaveBeenLastCalledWith('chat-1', '', expect.objectContaining({title: 'pricing.md'}), [attached]);

		// A file sits where its mark is in the words; a mark beyond the files named is taken out,
		// and marks alone, with no file, are nothing said.
		const mark = ATTACHMENT_MARK;
		await handleOpenThreadRoute(request({personaId: 'persona-1'}, {text: `Does ${mark} match ${mark}?`, attachments: [ref]}));
		expect(store.openThread).toHaveBeenLastCalledWith('chat-1', `Does ${mark} match ?`, expect.anything(), [attached]);
		expect((await handleOpenThreadRoute(request({personaId: 'persona-1'}, {text: ` ${mark} `}))).unwrapErr()).toEqual(ApiErr.validationError('Say something, or attach a file'));

		expect((await handleOpenThreadRoute(request({personaId: 'persona-1'}, {text: ' '}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleOpenThreadRoute(request({personaId: 'persona-1'}, {text: 'x'.repeat(20_001)}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleOpenThreadRoute(request({personaId: 'persona-1'}, {text: 'Too many', attachments: Array.from({length: 11}, () => ref)}))).unwrapErr().kind).toBe('parse_error');
		expect((await handleOpenThreadRoute(request({personaId: 'persona-1'}, {text: 'And this', attachments: [{...ref, fileId: 'file-2'}]}))).unwrapErr()).toMatchObject({
			kind: 'not_found',
			resource: 'file',
		});
		expect(store.openThread).toHaveBeenCalledTimes(3);
	});

	test('reply in a thread with what the viewer says and the files they attach, and say where there is no such thread', async () => {
		const {handleReplyInThreadRoute} = routes;
		const ref = {connectionId: 'drive-1', fileId: 'file-1', version: 'v1'};

		const replied = (await handleReplyInThreadRoute(request({personaId: 'persona-1', threadId: 'thread-2'}, {text: ' And the old prices? ', attachments: [ref]}))).unwrap();

		expect(store.replyInThread).toHaveBeenCalledWith('chat-1', 'thread-2', 'And the old prices?', [attached]);
		expect(replied.message).toEqual({id: 'e5', kind: 'person', text: 'And the old prices?', isError: false, at: now.toISOString(), attachments: [shownAttachment]});

		store.replyInThread.mockResolvedValue(Ok(null));
		expect((await handleReplyInThreadRoute(request({personaId: 'persona-1', threadId: 'thread-9'}, {text: 'Hi'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});
		store.getMemberChat.mockResolvedValue(Ok(null));
		expect((await handleReplyInThreadRoute(request({personaId: 'persona-1', threadId: 'thread-2'}, {text: 'Hi'}))).unwrapErr().kind).toBe('not_found');
		expect(store.replyInThread).toHaveBeenCalledTimes(2);
		expect(store.ensureMemberChat).not.toHaveBeenCalled();
	});

	test('put a file for a reply into the viewer’s own drive, keeping it in no input on the server, only for a thread of their chat', async () => {
		const {handleUploadThreadAttachmentRoute} = routes;
		store.hasChatThread.mockResolvedValue(Ok(true));

		expect((await handleUploadThreadAttachmentRoute(request({personaId: 'persona-1', threadId: 'thread-2'}))).unwrap()).toEqual({attachment: shownAttachment});
		expect(files.upload).toHaveBeenCalledWith(viewer, persona, expect.anything());
		expect(store.addDraftAttachment).not.toHaveBeenCalled();
		// Asked whether it is there, not read with all that was said in it.
		expect(store.hasChatThread).toHaveBeenCalledWith('chat-1', 'thread-2');
		expect(store.getChatThread).not.toHaveBeenCalled();

		files.upload.mockClear();
		store.hasChatThread.mockResolvedValue(Ok(false));
		expect((await handleUploadThreadAttachmentRoute(request({personaId: 'persona-1', threadId: 'thread-9'}))).unwrapErr()).toMatchObject({kind: 'not_found', resource: 'thread'});
		expect(files.upload).not.toHaveBeenCalled();
	});
});
