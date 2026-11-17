import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {callArguments, keepMarks, personMessageArgs, preview, SEND_TO_PERSON_TOOL, toAvatarColor} from '@proxy/utils/harness';
import type {ChatThreadRow, DraftAttachment, LastMessage, Persona, PersonaModel, PersonaRow, ThreadRow} from '@proxy/db/harness';
import {
	type chatAnswersSchema,
	type ChatHarness,
	type ChatPersona,
	type ChatThread,
	type ChatThreads,
	markReadBodySchema,
	MAX_ATTACHMENTS,
	personaBodySchema,
	type personaAnswerSchema,
	type personaListSchema,
	postMessageBodySchema,
	removeAttachmentBodySchema,
	type openedThreadSchema,
	type postedReplySchema,
	saveDraftBodySchema,
	saveThreadDraftBodySchema,
	threadDoneBodySchema,
	threadTitleBodySchema,
	type ThreadMessage,
	threadModelSchema,
	type ThreadStanding,
	type ThreadView,
	type uploadedAttachmentSchema,
} from '@proxy/contracts/harness';

import {chosenFor, harnessesOf, type HarnessRegistry, offeredTo} from '../backends/harness';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {manages} from '../utils/manages';
import type {AttachmentRef, ChatFiles} from './attachments';
import {type OrgViewer, requireViewer} from '../utils/user-org';
import {ensureBuiltInAgent} from './built-in-agent';
import {SHOWN_CALLS, threadOpening} from './thread-rules';
import {STANDING_WITHIN_MS} from './thread-standing';
import type {HarnessStore} from './store';

/**
 * The Chat page's routes, under the organization: the personas the member sees, their own and
 * General, which every member does, each named and given a head, all acting through the
 * organization's one built-in agent login, and the member's own chat with each, which holds
 * threads: each message they post in the chat opens one, whose agent works on it and answers them
 * there, and a reply in a thread goes on with it; the chat lists its threads, and each is read on
 * its own, with where it stands, which the member can say is done. The chat keeps what they typed in it and haven't sent, the files in its input, and how
 * far they have read it. A persona says which of the harnesses the server offers the organization
 * runs it and which of that harness's models it answers with (backends/harness.ts), chosen from
 * the chat's input by whoever may change it; a thread takes it as it is opened, and the member
 * may switch it from the thread's input without changing the persona. Nothing here runs the model: a message queues a job,
 * and the worker (worker.ts) does the rest; the page reads the threads again as they go.
 */

/** What the Chat page's routes need of the store. */
export type ChatStore = Pick<
	HarnessStore,
	| 'listPersonas'
	| 'listAnswers'
	| 'ensureFirstPersona'
	| 'getPersona'
	| 'createPersona'
	| 'updatePersona'
	| 'deletePersona'
	| 'getMemberChat'
	| 'ensureMemberChat'
	| 'listDraftAttachments'
	| 'addDraftAttachment'
	| 'removeDraftAttachment'
	| 'markThreadRead'
	| 'getChatDraft'
	| 'saveChatDraft'
	| 'getThreadDraft'
	| 'saveThreadDraft'
	| 'openThread'
	| 'replyInThread'
	| 'listChatThreads'
	| 'getChatThread'
	| 'hasChatThread'
	| 'getThreadModel'
	| 'setThreadModel'
	| 'markThreadDone'
	| 'archiveThread'
	| 'renameThread'
	| 'countChatAlerts'
>;

/** What the routes need of where a chat's files are kept: putting one there, naming those attached, and showing one; reading a picture for a model is the worker's. */
export type RouteFiles = Pick<ChatFiles, 'upload' | 'discard' | 'resolve' | 'shown'>;

/** The harnesses this server has, read where a route needs them, so that nothing is made as the routes are mounted. */
export type Harnesses = () => HarnessRegistry;

// Whether the viewer may rename, reface, switch the harness or the model of, or delete the persona: their own, or one every member sees that they made or whose organization they own (utils/manages.ts).
function managesPersona(viewer: OrgViewer, persona: PersonaRow): boolean {
	return manages(viewer, {ownerUserId: persona.ownerUserId, byId: persona.createdById});
}

// What the list says is waiting in a chat's input: what was typed, or, with nothing typed, the
// files put there, by their names.
function draftPreview(persona: {draft?: string | null; draftAttachments?: DraftAttachment[]}): string | null {
	if (persona.draft) {
		return preview(persona.draft);
	}
	const names = (persona.draftAttachments ?? []).map((attachment) => attachment.name);
	return names.length === 0 ? null : preview(names.join(', '));
}

// What runs a persona or a thread as this server offers the organization, which is what a turn of
// its gets; as kept where there is no harness at all, where nothing runs.
function asOffered(harnesses: Harnesses, viewer: OrgViewer, model: PersonaModel): PersonaModel {
	const chosen = chosenFor(offeredTo(harnesses(), viewer), model);
	return chosen === null ? {harness: model.harness, chatModel: model.chatModel} : {harness: chosen.harness.id, chatModel: chosen.model};
}

function toPersona(harnesses: Harnesses, viewer: OrgViewer, persona: PersonaRow & {lastMessage?: LastMessage | null; draft?: string | null; draftAttachments?: DraftAttachment[]}): ChatPersona {
	const last = persona.lastMessage ?? null;
	return {
		id: persona.id,
		name: persona.name,
		look: persona.look,
		color: toAvatarColor(persona.color),
		...asOffered(harnesses, viewer, persona),
		shared: persona.ownerUserId === null,
		mayChange: managesPersona(viewer, persona),
		lastMessage: last && {kind: last.kind, text: preview(last.text), at: last.createdAt.toISOString()},
		draft: draftPreview(persona),
		createdAt: persona.createdAt.toISOString(),
	};
}

// The harnesses a persona of the viewer's organization can run on here, as the dialog offers them.
function toHarnesses(registry: HarnessRegistry, viewer: OrgViewer): ChatHarness[] {
	return harnessesOf(offeredTo(registry, viewer)).map(({id, label, models}) => ({id, label, models}));
}

// The persona as the person made or changed it. What runs it is as they chose, where the server
// offers it the organization: a harness named has to be one of those, and a model named one of
// the harness's; the model left out is the harness's first, or the persona's own where the harness
// stays. With neither named, one changed (`existing`) keeps what it has, and a new one gets the
// first harness offered with its first model.
function readPersona(harnesses: Harnesses, viewer: OrgViewer, request: AuthenticatedRequest, existing: PersonaModel | null): Result<Persona, ApiError> {
	const parsed = parseSchema(personaBodySchema, request.body);
	if (parsed.isErr()) {
		return Err(parsed.error);
	}
	const {harness, chatModel, ...persona} = parsed.value;
	if (existing !== null && harness === undefined && chatModel === undefined) {
		return Ok(persona);
	}
	const sameHarness = harness === undefined || harness === existing?.harness;
	const chosen = chosenFor(offeredTo(harnesses(), viewer), {harness: harness ?? existing?.harness ?? '', chatModel: chatModel ?? (sameHarness ? (existing?.chatModel ?? '') : '')});
	if (chosen === null) {
		return Ok(persona);
	}
	if (harness !== undefined && chosen.harness.id !== harness) {
		return Err(ApiErr.validationError(`This server has no harness ${harness}.`));
	}
	if (chatModel !== undefined && chosen.model !== chatModel) {
		return Err(ApiErr.validationError(`${chosen.harness.label} has no model ${chatModel}.`));
	}
	return Ok({...persona, harness: chosen.harness.id, chatModel: chosen.model});
}

// The persona in the address, one of the organization's the viewer sees: another member's own is not found.
function requirePersona(store: ChatStore, viewer: OrgViewer, request: AuthenticatedRequest): Promise<Result<PersonaRow, ApiError>> {
	return Do(async ($) => {
		const personaId = request.params.personaId ?? '';
		return $(requirePresent($(await store.getPersona(viewer.orgId, viewer.userId, personaId)), ApiErr.notFound('persona', personaId)));
	});
}

// The persona in the address, which the viewer may change; forbidden for one they only talk to.
function requireManagedPersona(store: ChatStore, viewer: OrgViewer, request: AuthenticatedRequest): Promise<Result<PersonaRow, ApiError>> {
	return Do(async ($) => {
		const persona = $(await requirePersona(store, viewer, request));
		if (!managesPersona(viewer, persona)) {
			return $(Err(ApiErr.forbidden()));
		}
		return persona;
	});
}

// The viewer's chat with the persona, begun the first time, through the organization's built-in
// login, made with it where there is none yet.
function ensureChat(store: ChatStore, viewer: OrgViewer, persona: PersonaRow): Promise<Result<ThreadRow, ApiError>> {
	return Do(async ($) => {
		const existing = $(await store.getMemberChat(persona.id, viewer.userId));
		if (existing) {
			return existing;
		}
		const login = $(await ensureBuiltInAgent(viewer.orgId));
		return $(await store.ensureMemberChat({orgId: viewer.orgId, agentId: login.id, personaId: persona.id, userId: viewer.userId}));
	});
}

/** `GET /api/orgs/:org/chat/personas`: the organization's personas the viewer sees, their own and those every member does, the one last active in the viewer's chat with it first, and the harnesses the server has for one to run on; a General one, every member's, is made where there is none, after the viewer's own, so a message that names no agent always has one to go to. */
function handleListPersonasRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaListSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const personas = $(await store.listPersonas(viewer.orgId, viewer.userId));
		const offered = toHarnesses(harnesses(), viewer);
		const listed = personas.map((persona) => toPersona(harnesses, viewer, persona));
		if (personas.some((persona) => persona.ownerUserId === null)) {
			return {personas: listed, harnesses: offered};
		}
		const general = $(await store.ensureFirstPersona(viewer.orgId));
		return {personas: [...listed, toPersona(harnesses, viewer, general)], harnesses: offered};
	});
}

/** `GET /api/orgs/:org/chat/answers`: the persona's last answer in each of the viewer's chats that has one, and each of its threads whose last answer they haven't seen, and whether its turn has ended; read only, for every page to ask every so often. */
function handleListAnswersRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<z.infer<typeof chatAnswersSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const answers = $(await store.listAnswers(viewer.orgId, viewer.userId));
		return {
			answers: answers.map(({personaId, personaName, answer, unread}) => ({
				personaId,
				name: personaName,
				answer: {id: answer.id, text: preview(answer.text)},
				unread: unread.map((one) => ({
					threadId: one.threadId,
					answer: {id: one.answer.id, text: preview(one.answer.text)},
					ended: one.ended,
				})),
			})),
		};
	});
}

/** `POST /api/orgs/:org/chat/personas` with `{name, look, color, harness?, chatModel?}`: a new persona, the viewer's own, and the organization's built-in login with it where there is none yet. */
function handleCreatePersonaRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const persona = $(readPersona(harnesses, viewer, request, null));
		$(await ensureBuiltInAgent(viewer.orgId));
		const made = $(await store.createPersona(viewer.orgId, viewer.userId, persona));
		return {persona: toPersona(harnesses, viewer, made)};
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId` with `{name, look, color, harness?, chatModel?}`: the persona renamed, with another head, or switched to another harness or model from its next turn on, in every thread of every chat with it. */
function handleUpdatePersonaRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const existing = $(await requireManagedPersona(store, viewer, request));
		const persona = $(readPersona(harnesses, viewer, request, existing));
		if (!$(await store.updatePersona(viewer.orgId, existing.id, persona))) {
			return $(Err(ApiErr.notFound('persona', existing.id)));
		}
		return {persona: toPersona(harnesses, viewer, {...existing, ...persona})};
	});
}

/** `DELETE /api/orgs/:org/chat/personas/:personaId`: the persona, with every chat with it. */
function handleDeletePersonaRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const persona = $(await requireManagedPersona(store, viewer, request));
		if (!$(await store.deletePersona(viewer.orgId, persona.id))) {
			return $(Err(ApiErr.notFound('persona', persona.id)));
		}
	});
}

// What the viewer says, in the chat or in one of its threads, and the files they attach to it. A
// mark in the text is a file's place: one beyond the files named stands for nothing, and marks
// alone are nothing said.
function readMessage(request: AuthenticatedRequest): Result<{text: string; refs: AttachmentRef[]}, ApiError> {
	const parsed = parseSchema(postMessageBodySchema, request.body);
	if (parsed.isErr()) {
		return Err(parsed.error);
	}
	const {text: typed, attachments: refs} = parsed.value;
	const text = keepMarks(typed, refs.length).trim();
	if (text === '' && refs.length === 0) {
		return Err(ApiErr.validationError('Say something, or attach a file'));
	}
	return Ok({text, refs});
}

const INPUT_FULL = `A message carries at most ${MAX_ATTACHMENTS} files.`;

/** `POST /api/orgs/:org/chat/personas/:personaId/attachments`: a file put in the chat's input, kept in the viewer's own drive and in the input, with what they typed there, until they send their next message or take it out. */
function handleUploadAttachmentRoute(store: ChatStore, files: RouteFiles, request: AuthenticatedRequest): Promise<Result<z.infer<typeof uploadedAttachmentSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await ensureChat(store, viewer, persona));
		// Refused before the bytes are taken where the input is full, and again as it is put there,
		// since another upload may have filled it meanwhile.
		if ($(await store.listDraftAttachments(chat.id)).length >= MAX_ATTACHMENTS) {
			return $(Err(ApiErr.conflict(INPUT_FULL)));
		}
		const attachment = $(await files.upload(viewer, persona, request));
		const {shown: _shown, gone: _gone, ...kept} = attachment;
		const added = await store.addDraftAttachment(chat.id, kept, MAX_ATTACHMENTS);
		// A file the input didn't take isn't left in the drive with nothing pointing at it.
		if (added.isErr() || !added.value) {
			$(await files.discard(viewer, attachment));
		}
		if (!$(added)) {
			return $(Err(ApiErr.notFound('chat', chat.id)));
		}
		return {attachment};
	});
}

/** `DELETE /api/orgs/:org/chat/personas/:personaId/attachments` with `{connectionId, fileId, version}`: takes a file out of the chat's input; the file stays in its drive. */
function handleRemoveAttachmentRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const file = $(parseSchema(removeAttachmentBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await ensureChat(store, viewer, persona));
		if (!$(await store.removeDraftAttachment(chat.id, file))) {
			return $(Err(ApiErr.notFound('chat', chat.id)));
		}
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId/draft` with `{text, attachments}`: what the viewer has typed in their chat with the persona and not sent, kept in place of what was; nothing but whitespace forgets it. Where files sit among the words, the files in the input are kept in the order named. */
function handleSaveDraftRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const {text, attachments: order} = $(parseSchema(saveDraftBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await ensureChat(store, viewer, persona));
		if (!$(await store.saveChatDraft(chat.id, text.trim() === '' ? null : text, order))) {
			return $(Err(ApiErr.notFound('chat', chat.id)));
		}
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/read` with `{entryId}`: the viewer was shown that answer in one of the threads of their chat with the persona, which is read up to it; what the persona said in it after, and in the chat's other threads, stays unread. */
function handleMarkReadRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const {entryId} = $(parseSchema(markReadBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		// Read, never begun: a viewer without a chat has no answer in it to have seen.
		const chat = $(await store.getMemberChat(persona.id, viewer.userId));
		if (!chat || !$(await store.markThreadRead(chat.id, entryId))) {
			return $(Err(ApiErr.notFound('entry', entryId)));
		}
	});
}

// Something a thread shows, with the entry it comes from.
type Shown = {entryId: string; message: ThreadMessage};

// What a thread shows (db/harness listChatThreads), each message with the files it went with: what
// the person said; the events that came into it; what the persona answered in words, then what it
// told the person as it went in the same step; not the calls it worked through.
function threadShown(thread: ChatThreadRow, files: RouteFiles): Shown[] {
	const attachmentsOf = (entryId: string) => thread.attachments.filter((attachment) => attachment.entryId === entryId).map(files.shown);
	return thread.entries.flatMap((entry): Shown[] => {
		const at = entry.createdAt.toISOString();
		const from = (message: ThreadMessage): Shown => ({entryId: entry.id, message});
		if (entry.kind === 'person' || entry.kind === 'event') {
			return [from({id: entry.id, kind: entry.kind, text: entry.text, isError: entry.isError, at, attachments: attachmentsOf(entry.id)})];
		}
		if (entry.kind !== 'assistant') {
			return [];
		}
		const said: Shown[] = entry.text === '' ? [] : [from({id: entry.id, kind: 'assistant', text: entry.text, isError: entry.isError, at, attachments: attachmentsOf(entry.id)})];
		const told = (entry.toolCalls ?? []).flatMap((call): Shown[] => {
			const message = call.name === SEND_TO_PERSON_TOOL ? personMessageArgs(callArguments(call)) : null;
			return message ? [from({id: `${entry.id}:${call.id}`, kind: 'assistant', text: message.text, isError: false, at, attachments: []})] : [];
		});
		return [...said, ...told];
	});
}

// Where the thread stands: in progress while it is at work or asleep; once stopped, waiting for
// the person where its turn's end said so and nobody has said otherwise since, else watching
// where alerts come to it, which wake it again, or done.
function standingOf(thread: ChatThreadRow): ThreadStanding {
	if (thread.state.kind !== 'stopped') {
		return 'in_progress';
	}
	if (thread.standing.waitingForMember) {
		return 'waiting';
	}
	return thread.alerts > 0 ? 'watching' : 'done';
}

// Whether where the thread stands was written from everything said in it, nothing past it.
function standingCurrent(thread: ChatThreadRow): boolean {
	const {summarySeq} = thread.standing;
	return summarySeq !== null && !thread.entries.some((entry) => entry.pending || entry.seq > summarySeq);
}

// The thread's summary while it is current.
function currentSummary(thread: ChatThreadRow): string | null {
	return standingCurrent(thread) ? thread.standing.summary : null;
}

// Whether where the thread stands is still being read: it stopped a moment ago, and nothing was
// written for what was said in it last. Its turn's end writes it in the background, after the
// thread reads as stopped (worker.ts), so whoever lists it reads it again until then; past the
// time that may take, nothing is coming, as on a server whose model reads none.
function standingPending(thread: ChatThreadRow, now: Date): boolean {
	const last = thread.entries.at(-1);
	if (thread.state.kind !== 'stopped' || last === undefined) {
		return false;
	}
	return !standingCurrent(thread) && now.getTime() - last.createdAt.getTime() < STANDING_WITHIN_MS;
}

// A thread as the chat lists it, from what it shows: where it stands, and its summary while it is
// current; what opened it, the start of the latest
// thing the persona said and the entry it comes from, how many messages it holds and when the
// last came, or, with none, when it was opened.
function toChatThread(thread: ChatThreadRow, shown: Shown[], now: Date): ChatThread {
	const messages = shown.map(({message}) => message);
	const first = messages[0];
	const latest = shown.findLast(({message}) => message.kind === 'assistant');
	const opener = first?.kind === 'person' ? {kind: 'person' as const, text: first.text, attachments: first.attachments} : first?.kind === 'event' ? {kind: 'event' as const, text: first.text} : null;
	const {state} = thread;
	return {
		id: thread.id,
		title: thread.title ?? '',
		state: state.kind === 'asleep' ? {kind: 'asleep', until: state.until.toISOString()} : state,
		standing: standingOf(thread),
		standingPending: standingPending(thread, now),
		opener,
		summary: currentSummary(thread),
		latest: latest ? preview(latest.message.text) : null,
		latestEntryId: latest?.entryId ?? null,
		messageCount: messages.length,
		lastMessageAt: messages.at(-1)?.at ?? thread.createdAt.toISOString(),
		createdAt: thread.createdAt.toISOString(),
		alerts: thread.alerts,
		openedByAlert: thread.openedByAlert,
	};
}

// The viewer's chat with the persona in the address, which a thread is of; never begun: a viewer
// without one has no thread in it.
function requireChat(store: ChatStore, viewer: OrgViewer, persona: PersonaRow, threadId: string): Promise<Result<ThreadRow, ApiError>> {
	return Do(async ($) => {
		return $(requirePresent($(await store.getMemberChat(persona.id, viewer.userId)), ApiErr.notFound('thread', threadId)));
	});
}

// The thread in the address, one of the viewer's chat with the persona in the address.
function requireChatThread(store: ChatStore, viewer: OrgViewer, persona: PersonaRow, threadId: string, now: Date): Promise<Result<ChatThreadRow, ApiError>> {
	return Do(async ($) => {
		const chat = $(await requireChat(store, viewer, persona, threadId));
		return $(requirePresent($(await store.getChatThread(chat.id, threadId, SHOWN_CALLS, now)), ApiErr.notFound('thread', threadId)));
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/threads`: the viewer's chat with the persona, begun where there was none: what they typed in it and haven't sent, and its threads in the order they were opened, the newest last, so that none moves when a message comes to it. */
function handleListThreadsRoute(store: ChatStore, harnesses: Harnesses, files: RouteFiles, request: AuthenticatedRequest): Promise<Result<ChatThreads, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await ensureChat(store, viewer, persona));
		const now = new Date();
		const [threads, draft, waiting, alerts] = await Promise.all([
			store.listChatThreads(chat.id, SHOWN_CALLS, now),
			store.getChatDraft(chat.id),
			store.listDraftAttachments(chat.id),
			store.countChatAlerts(chat.id),
		]);
		const listed = $(threads).map((thread) => toChatThread(thread, threadShown(thread, files), now));
		return {
			persona: toPersona(harnesses, viewer, persona),
			draft: $(draft),
			// Put in the input from the person's drive, where a file is kept as long as it waits there.
			draftAttachments: $(waiting).map((attachment) => files.shown({...attachment, gone: false})),
			threads: listed.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
			alerts: $(alerts),
		};
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/threads/:threadId`: one thread of the viewer's chat with the persona: what it is up to, what runs it, and what was said in it. */
function handleGetChatThreadRoute(store: ChatStore, harnesses: Harnesses, files: RouteFiles, request: AuthenticatedRequest): Promise<Result<ThreadView, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const persona = $(await requirePersona(store, viewer, request));
		const now = new Date();
		const thread = $(await requireChatThread(store, viewer, persona, request.params.threadId ?? '', now));
		const shown = threadShown(thread, files);
		const [found, draft] = await Promise.all([store.getThreadModel(thread), store.getThreadDraft(thread.parentThreadId ?? '', thread.id)]);
		const model = $(found) ?? persona;
		return {
			persona: toPersona(harnesses, viewer, persona),
			thread: toChatThread(thread, shown, now),
			model: asOffered(harnesses, viewer, model),
			// At work as long as it hasn't stopped: a thread asleep until it wakes is still at it.
			busy: thread.state.kind !== 'stopped',
			messages: shown.map(({message}) => message),
			draft: $(draft),
		};
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId/threads/:threadId/draft` with `{text}`: what the viewer has typed in a thread of their chat with the persona and not sent, kept in place of what was; nothing but whitespace forgets it, as their reply in it does. */
function handleSaveThreadDraftRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const threadId = request.params.threadId ?? '';
		const {text} = $(parseSchema(saveThreadDraftBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await requireChat(store, viewer, persona, threadId));
		if (!$(await store.saveThreadDraft(chat.id, threadId, text.trim() === '' ? null : text))) {
			return $(Err(ApiErr.notFound('thread', threadId)));
		}
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/threads` with `{text, attachments}`: a thread opened in the viewer's chat with the persona with what they say, and the files they attach, each as it is when it is said; its persona is woken in it. */
function handleOpenThreadRoute(store: ChatStore, files: RouteFiles, request: AuthenticatedRequest): Promise<Result<z.infer<typeof openedThreadSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const {text, refs} = $(readMessage(request));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await ensureChat(store, viewer, persona));
		const attachments = refs.length === 0 ? [] : $(await files.resolve(viewer, refs));
		const opening = threadOpening(chat, {text, files: attachments.map((attachment) => attachment.name)});
		const opened = $(requirePresent($(await store.openThread(chat.id, text, opening, attachments)), ApiErr.notFound('thread', chat.id)));
		const now = new Date();
		const thread = $(requirePresent($(await store.getChatThread(chat.id, opened.thread.id, SHOWN_CALLS, now)), ApiErr.notFound('thread', opened.thread.id)));
		return {thread: toChatThread(thread, threadShown(thread, files), now)};
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/threads/:threadId/messages` with `{text, attachments}`: what the viewer replies in a thread of their chat with the persona, with the files they attach; the thread takes it up. */
function handleReplyInThreadRoute(store: ChatStore, files: RouteFiles, request: AuthenticatedRequest): Promise<Result<z.infer<typeof postedReplySchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const threadId = request.params.threadId ?? '';
		const {text, refs} = $(readMessage(request));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await requireChat(store, viewer, persona, threadId));
		const attachments = refs.length === 0 ? [] : $(await files.resolve(viewer, refs));
		const entry = $(requirePresent($(await store.replyInThread(chat.id, threadId, text, attachments)), ApiErr.notFound('thread', threadId)));
		// Read from their drives just now.
		const shown = attachments.map((attachment) => files.shown({...attachment, gone: false}));
		return {message: {id: entry.id, kind: 'person', text: entry.text, isError: false, at: entry.createdAt.toISOString(), attachments: shown}};
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/threads/:threadId/attachments`: a file for a reply in a thread, kept in the viewer's own drive, to be attached to what they reply next; the page holds it until then. */
function handleUploadThreadAttachmentRoute(store: ChatStore, files: RouteFiles, request: AuthenticatedRequest): Promise<Result<z.infer<typeof uploadedAttachmentSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const threadId = request.params.threadId ?? '';
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await requireChat(store, viewer, persona, threadId));
		if (!$(await store.hasChatThread(chat.id, threadId))) {
			return $(Err(ApiErr.notFound('thread', threadId)));
		}
		return {attachment: $(await files.upload(viewer, persona, request))};
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/threads/:threadId/done`: the viewer says a thread of their chat with the persona is done: it no longer waits for them, until its agent stops for them again; with `cancelAlerts`, the alerts that come to it are cancelled. */
function handleMarkThreadDoneRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const threadId = request.params.threadId ?? '';
		const {cancelAlerts = false} = $(parseSchema(threadDoneBodySchema, request.body ?? {}));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await requireChat(store, viewer, persona, threadId));
		if (!$(await store.markThreadDone(chat.id, threadId, cancelAlerts))) {
			return $(Err(ApiErr.notFound('thread', threadId)));
		}
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/threads/:threadId/archive`: the viewer archives a thread of their chat with the persona: the chat's list no longer has it, until they reply in it or an alert takes it up; the alerts that come to it are cancelled. */
function handleArchiveThreadRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const threadId = request.params.threadId ?? '';
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await requireChat(store, viewer, persona, threadId));
		if (!$(await store.archiveThread(chat.id, threadId))) {
			return $(Err(ApiErr.notFound('thread', threadId)));
		}
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId/threads/:threadId/title` with `{title}`: the viewer renames a thread of their chat with the persona, its task in the activity log with it; the small model names it no more. */
function handleRenameThreadRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const threadId = request.params.threadId ?? '';
		const {title} = $(parseSchema(threadTitleBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await requireChat(store, viewer, persona, threadId));
		if (!$(await store.renameThread(chat.id, threadId, title))) {
			return $(Err(ApiErr.notFound('thread', threadId)));
		}
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId/threads/:threadId/model` with `{harness, chatModel}`: the viewer switches what runs a thread of their chat with the persona, from its next turn on, to one of the harnesses the server offers the organization and one of its models; the persona, and its other threads, are left as they are. The thread is the viewer's alone, so they may, whatever persona it is with. */
function handleSetThreadModelRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		const threadId = request.params.threadId ?? '';
		const asked = $(parseSchema(threadModelSchema, request.body));
		const chosen = chosenFor(offeredTo(harnesses(), viewer), asked);
		if (chosen === null || chosen.harness.id !== asked.harness) {
			return $(Err(ApiErr.validationError(`This server has no harness ${asked.harness}.`)));
		}
		if (chosen.model !== asked.chatModel) {
			return $(Err(ApiErr.validationError(`${chosen.harness.label} has no model ${asked.chatModel}.`)));
		}
		const persona = $(await requirePersona(store, viewer, request));
		const chat = $(await requireChat(store, viewer, persona, threadId));
		if (!$(await store.setThreadModel(chat.id, threadId, asked))) {
			return $(Err(ApiErr.notFound('thread', threadId)));
		}
	});
}

/** The Chat page's routes, on the store, the harnesses the server has, and where a chat's files are kept. */
export function chatRoutes(store: ChatStore, harnesses: Harnesses, files: RouteFiles) {
	return {
		handleListPersonasRoute: (request: AuthenticatedRequest) => handleListPersonasRoute(store, harnesses, request),
		handleListAnswersRoute: (request: AuthenticatedRequest) => handleListAnswersRoute(store, request),
		handleCreatePersonaRoute: (request: AuthenticatedRequest) => handleCreatePersonaRoute(store, harnesses, request),
		handleUpdatePersonaRoute: (request: AuthenticatedRequest) => handleUpdatePersonaRoute(store, harnesses, request),
		handleDeletePersonaRoute: (request: AuthenticatedRequest) => handleDeletePersonaRoute(store, request),
		handleUploadAttachmentRoute: (request: AuthenticatedRequest) => handleUploadAttachmentRoute(store, files, request),
		handleRemoveAttachmentRoute: (request: AuthenticatedRequest) => handleRemoveAttachmentRoute(store, request),
		handleMarkReadRoute: (request: AuthenticatedRequest) => handleMarkReadRoute(store, request),
		handleSaveDraftRoute: (request: AuthenticatedRequest) => handleSaveDraftRoute(store, request),
		handleSaveThreadDraftRoute: (request: AuthenticatedRequest) => handleSaveThreadDraftRoute(store, request),
		handleListThreadsRoute: (request: AuthenticatedRequest) => handleListThreadsRoute(store, harnesses, files, request),
		handleGetChatThreadRoute: (request: AuthenticatedRequest) => handleGetChatThreadRoute(store, harnesses, files, request),
		handleOpenThreadRoute: (request: AuthenticatedRequest) => handleOpenThreadRoute(store, files, request),
		handleReplyInThreadRoute: (request: AuthenticatedRequest) => handleReplyInThreadRoute(store, files, request),
		handleUploadThreadAttachmentRoute: (request: AuthenticatedRequest) => handleUploadThreadAttachmentRoute(store, files, request),
		handleSetThreadModelRoute: (request: AuthenticatedRequest) => handleSetThreadModelRoute(store, harnesses, request),
		handleRenameThreadRoute: (request: AuthenticatedRequest) => handleRenameThreadRoute(store, request),
		handleMarkThreadDoneRoute: (request: AuthenticatedRequest) => handleMarkThreadDoneRoute(store, request),
		handleArchiveThreadRoute: (request: AuthenticatedRequest) => handleArchiveThreadRoute(store, request),
	};
}
