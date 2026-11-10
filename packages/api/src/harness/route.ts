import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, parseSchema, requirePresent} from '@proxy/utils';
import {keepMarks, preview, threadState, toAvatarColor} from '@proxy/utils/harness';
import type {DraftAttachment, EntryRow, LastMessage, Persona, PersonaModel, PersonaRow, ThreadRow} from '@proxy/db/harness';
import {
	type ChatAttachment,
	type ChatEntry,
	type chatAnswersSchema,
	type ChatHarness,
	type ChatPersona,
	markReadBodySchema,
	MAX_ATTACHMENTS,
	personaBodySchema,
	type personaAnswerSchema,
	type personaListSchema,
	postMessageBodySchema,
	removeAttachmentBodySchema,
	type postedMessageSchema,
	saveDraftBodySchema,
	type ThreadLog,
	type uploadedAttachmentSchema,
} from '@proxy/contracts/harness';

import {chosenFor, harnessesOf, type HarnessRegistry} from '../backends/harness';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {manages} from '../utils/manages';
import type {ChatFiles} from './attachments';
import {type OrgViewer, requireViewer} from '../utils/user-org';
import {ensureBuiltInAgent} from './built-in-agent';
import type {HarnessStore} from './store';

/**
 * The Chat page's routes, under the organization: its personas, which every member sees, each
 * named and given a head, all acting through the organization's one built-in agent login, and the
 * member's own conversation with each, its log, and what it and its sub-agents are up to. A persona
 * says which of the server's harnesses runs it and which of that harness's models it answers with
 * (backends/harness.ts), chosen from the conversation's input by whoever may change it. Behind the `harness` experiment. Nothing here runs the model: a message queues a job, and
 * the worker (worker.ts) does the rest; the page reads the log again as it goes.
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
	| 'getMemberThread'
	| 'ensureMemberThread'
	| 'listShownEntries'
	| 'listOpenJobs'
	| 'appendPersonMessage'
	| 'listAttachments'
	| 'listDraftAttachments'
	| 'addDraftAttachment'
	| 'removeDraftAttachment'
	| 'markThreadRead'
	| 'getThreadDraft'
	| 'saveThreadDraft'
>;

/** The harnesses this server has, read where a route needs them, so that nothing is made as the routes are mounted. */
export type Harnesses = () => HarnessRegistry;

// Whether the viewer may rename, reface, switch the harness or the model of, or delete the persona: whoever made it, or the organization's owner (utils/manages.ts).
function managesPersona(viewer: OrgViewer, persona: PersonaRow): boolean {
	return manages(viewer, {ownerUserId: null, byId: persona.createdById});
}

// What the list says is waiting in a conversation's input: what was typed, or, with nothing typed,
// the files put there, by their names.
function draftPreview(persona: {draft?: string | null; draftAttachments?: DraftAttachment[]}): string | null {
	if (persona.draft) {
		return preview(persona.draft);
	}
	const names = (persona.draftAttachments ?? []).map((attachment) => attachment.name);
	return names.length === 0 ? null : preview(names.join(', '));
}

function toPersona(harnesses: Harnesses, viewer: OrgViewer, persona: PersonaRow & {lastMessage?: LastMessage | null; draft?: string | null; draftAttachments?: DraftAttachment[]}): ChatPersona {
	const last = persona.lastMessage ?? null;
	// What runs it as this server has it, which is what a turn of its gets; as kept on a server
	// with no harness at all, where nothing runs.
	const chosen = chosenFor(harnesses(), persona);
	return {
		id: persona.id,
		name: persona.name,
		look: persona.look,
		color: toAvatarColor(persona.color),
		harness: chosen?.harness.id ?? persona.harness,
		chatModel: chosen?.model ?? persona.chatModel,
		mayChange: managesPersona(viewer, persona),
		lastMessage: last && {kind: last.kind, text: preview(last.text), at: last.createdAt.toISOString()},
		draft: draftPreview(persona),
		createdAt: persona.createdAt.toISOString(),
	};
}

// The harnesses a persona can run on here, as the dialog offers them.
function toHarnesses(registry: HarnessRegistry): ChatHarness[] {
	return harnessesOf(registry).map(({id, label, models}) => ({id, label, models}));
}

// The persona as the person made or changed it. What runs it is as they chose, where the server
// has it: a harness named has to be one of the server's, and a model named one of the harness's;
// the model left out is the harness's first, or the persona's own where the harness stays. With
// neither named, one changed (`existing`) keeps what it has, and a new one gets the server's
// first harness with its first model.
function readPersona(harnesses: Harnesses, request: AuthenticatedRequest, existing: PersonaModel | null): Result<Persona, ApiError> {
	const parsed = parseSchema(personaBodySchema, request.body);
	if (parsed.isErr()) {
		return Err(parsed.error);
	}
	const {harness, chatModel, ...persona} = parsed.value;
	if (existing !== null && harness === undefined && chatModel === undefined) {
		return Ok(persona);
	}
	const sameHarness = harness === undefined || harness === existing?.harness;
	const chosen = chosenFor(harnesses(), {harness: harness ?? existing?.harness ?? '', chatModel: chatModel ?? (sameHarness ? (existing?.chatModel ?? '') : '')});
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

// The entries the person sees (db/harness listShownEntries), as their kinds, for the response.
function isShown(entry: EntryRow): entry is EntryRow & {kind: ChatEntry['kind']} {
	return entry.kind === 'person' || (entry.kind === 'assistant' && entry.text !== '');
}

function toEntry(entry: EntryRow & {kind: ChatEntry['kind']}, attachments: ChatAttachment[]): ChatEntry {
	return {id: entry.id, kind: entry.kind, text: entry.text, isError: entry.isError, at: entry.createdAt.toISOString(), attachments};
}

/** The viewer, in an organization with Chat on: the Chat page's routes and the Alerts page's take it. */
export function requireChat(request: AuthenticatedRequest): Promise<Result<OrgViewer, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		if (!hasExperiment(viewer, 'harness')) {
			return $(Err(ApiErr.forbidden()));
		}
		return viewer;
	});
}

// The persona in the address, one of the organization's.
function requirePersona(store: ChatStore, viewer: OrgViewer, request: AuthenticatedRequest): Promise<Result<PersonaRow, ApiError>> {
	return Do(async ($) => {
		const personaId = request.params.personaId ?? '';
		return $(requirePresent($(await store.getPersona(viewer.orgId, personaId)), ApiErr.notFound('persona', personaId)));
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

// The viewer's conversation with the persona, begun the first time, through the organization's
// built-in login, made with it where there is none yet.
function requireThread(store: ChatStore, viewer: OrgViewer, persona: PersonaRow): Promise<Result<ThreadRow, ApiError>> {
	return Do(async ($) => {
		const existing = $(await store.getMemberThread(persona.id, viewer.userId));
		if (existing) {
			return existing;
		}
		const login = $(await ensureBuiltInAgent(viewer.orgId));
		return $(await store.ensureMemberThread({orgId: viewer.orgId, agentId: login.id, personaId: persona.id, userId: viewer.userId}));
	});
}

/** `GET /api/orgs/:org/chat/personas`: the organization's personas, the one last active in the viewer's conversation first, with the viewer's conversations, and the harnesses the server has for one to run on; a General one is made where it has none. */
function handleListPersonasRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaListSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const personas = $(await store.listPersonas(viewer.orgId, viewer.userId));
		const offered = toHarnesses(harnesses());
		if (personas.length > 0) {
			return {personas: personas.map((persona) => toPersona(harnesses, viewer, persona)), harnesses: offered};
		}
		const first = $(await store.ensureFirstPersona(viewer.orgId));
		return {personas: [toPersona(harnesses, viewer, first)], harnesses: offered};
	});
}

/** `GET /api/orgs/:org/chat/answers`: the persona's last answer in each of the viewer's conversations that has one, and whether they haven't seen it; read only, for every page to ask every so often. */
function handleListAnswersRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<z.infer<typeof chatAnswersSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const answers = $(await store.listAnswers(viewer.orgId, viewer.userId));
		return {
			answers: answers.map(({personaId, personaName, answer, unread}) => ({
				personaId,
				name: personaName,
				answer: {id: answer.id, text: preview(answer.text)},
				unread,
			})),
		};
	});
}

/** `POST /api/orgs/:org/chat/personas` with `{name, look, color, harness?, chatModel?}`: a new persona, every member's, and the organization's built-in login with it where there is none yet. */
function handleCreatePersonaRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(readPersona(harnesses, request, null));
		$(await ensureBuiltInAgent(viewer.orgId));
		const made = $(await store.createPersona(viewer.orgId, viewer.userId, persona));
		return {persona: toPersona(harnesses, viewer, made)};
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId` with `{name, look, color, harness?, chatModel?}`: the persona renamed, with another head, or switched to another harness or model from its next turn on, every member's conversation with it and its sub-agents'. */
function handleUpdatePersonaRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const existing = $(await requireManagedPersona(store, viewer, request));
		const persona = $(readPersona(harnesses, request, existing));
		if (!$(await store.updatePersona(viewer.orgId, existing.id, persona))) {
			return $(Err(ApiErr.notFound('persona', existing.id)));
		}
		return {persona: toPersona(harnesses, viewer, {...existing, ...persona})};
	});
}

/** `DELETE /api/orgs/:org/chat/personas/:personaId`: the persona, with every member's conversation with it. */
function handleDeletePersonaRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(await requireManagedPersona(store, viewer, request));
		if (!$(await store.deletePersona(viewer.orgId, persona.id))) {
			return $(Err(ApiErr.notFound('persona', persona.id)));
		}
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/thread`: the viewer's conversation with the persona, begun where there was none, what they said while it was answering at the end, whether the persona is busy on it, its sub-agents included, and what they typed in it and haven't sent. */
function handleGetThreadRoute(store: ChatStore, harnesses: Harnesses, files: ChatFiles, request: AuthenticatedRequest): Promise<Result<ThreadLog, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireThread(store, viewer, persona));
		const [entries, jobs, draft, attached, waiting] = await Promise.all([
			store.listShownEntries(thread.id),
			store.listOpenJobs(thread.id),
			store.getThreadDraft(thread.id),
			store.listAttachments(thread.id),
			store.listDraftAttachments(thread.id),
		]);
		// The conversation's and its sub-agents' jobs together: asleep only when every one of them is.
		const state = threadState($(jobs), new Date());
		const attachments = $(attached);
		return {
			persona: toPersona(harnesses, viewer, persona),
			entries: $(entries)
				.filter(isShown)
				.map((entry) => toEntry(entry, attachments.filter((attachment) => attachment.entryId === entry.id).map(files.shown))),
			busy: state.kind === 'working',
			sleepingUntil: state.kind === 'asleep' ? state.until.toISOString() : null,
			draft: $(draft),
			draftAttachments: $(waiting).map(files.shown),
		};
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/messages` with `{text, attachments}`: what the viewer says to the persona, with the files they attach to it, each as it is when it is said; it is woken. */
function handlePostMessageRoute(store: ChatStore, files: ChatFiles, request: AuthenticatedRequest): Promise<Result<z.infer<typeof postedMessageSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const {text: typed, attachments: refs} = $(parseSchema(postMessageBodySchema, request.body));
		// A mark in the text is a file's place: one beyond the files named stands for nothing, and
		// marks alone are nothing said.
		const text = keepMarks(typed, refs.length).trim();
		if (text === '' && refs.length === 0) {
			return $(Err(ApiErr.validationError('Say something, or attach a file')));
		}
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireThread(store, viewer, persona));
		const attachments = refs.length === 0 ? [] : $(await files.resolve(viewer, refs));
		const entry = $(requirePresent($(await store.appendPersonMessage(thread.id, text, attachments)), ApiErr.notFound('thread', thread.id)));
		return {entry: toEntry({...entry, kind: 'person'}, attachments.map(files.shown))};
	});
}

const INPUT_FULL = `A message carries at most ${MAX_ATTACHMENTS} files.`;

/** `POST /api/orgs/:org/chat/personas/:personaId/attachments`: a file put in the conversation's input, kept in the viewer's own drive and in the input, with what they typed there, until they send their next message or take it out. */
function handleUploadAttachmentRoute(store: ChatStore, files: ChatFiles, request: AuthenticatedRequest): Promise<Result<z.infer<typeof uploadedAttachmentSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireThread(store, viewer, persona));
		// Refused before the bytes are taken where the input is full, and again as it is put there,
		// since another upload may have filled it meanwhile.
		if ($(await store.listDraftAttachments(thread.id)).length >= MAX_ATTACHMENTS) {
			return $(Err(ApiErr.conflict(INPUT_FULL)));
		}
		const attachment = $(await files.upload(viewer, persona, request));
		const {shown: _shown, ...kept} = attachment;
		$(requirePresent($(await store.addDraftAttachment(thread.id, kept, MAX_ATTACHMENTS)), ApiErr.notFound('thread', thread.id)));
		return {attachment};
	});
}

/** `DELETE /api/orgs/:org/chat/personas/:personaId/attachments` with `{connectionId, fileId, version}`: takes a file out of the conversation's input; the file stays in its drive. */
function handleRemoveAttachmentRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const file = $(parseSchema(removeAttachmentBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireThread(store, viewer, persona));
		$(requirePresent($(await store.removeDraftAttachment(thread.id, file)), ApiErr.notFound('thread', thread.id)));
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId/draft` with `{text, attachments}`: what the viewer has typed to the persona and not sent, kept in place of what was; nothing but whitespace forgets it. Where files sit among the words, the files in the input are kept in the order named. */
function handleSaveDraftRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const {text, attachments: order} = $(parseSchema(saveDraftBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireThread(store, viewer, persona));
		if (!$(await store.saveThreadDraft(thread.id, text.trim() === '' ? null : text, order))) {
			return $(Err(ApiErr.notFound('thread', thread.id)));
		}
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/read` with `{entryId}`: the viewer was shown their conversation with the persona up to that answer; what the persona said after it stays unread. */
function handleMarkReadRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const {entryId} = $(parseSchema(markReadBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		// Read, never begun: a viewer without a conversation has no answer in it to have seen.
		const thread = $(await store.getMemberThread(persona.id, viewer.userId));
		if (!thread || !$(await store.markThreadRead(thread.id, entryId))) {
			return $(Err(ApiErr.notFound('entry', entryId)));
		}
	});
}

/** The Chat page's routes, on the store, the harnesses the server has, and where a conversation's files are kept. */
export function chatRoutes(store: ChatStore, harnesses: Harnesses, files: ChatFiles) {
	return {
		handleListPersonasRoute: (request: AuthenticatedRequest) => handleListPersonasRoute(store, harnesses, request),
		handleListAnswersRoute: (request: AuthenticatedRequest) => handleListAnswersRoute(store, request),
		handleCreatePersonaRoute: (request: AuthenticatedRequest) => handleCreatePersonaRoute(store, harnesses, request),
		handleUpdatePersonaRoute: (request: AuthenticatedRequest) => handleUpdatePersonaRoute(store, harnesses, request),
		handleDeletePersonaRoute: (request: AuthenticatedRequest) => handleDeletePersonaRoute(store, request),
		handleGetThreadRoute: (request: AuthenticatedRequest) => handleGetThreadRoute(store, harnesses, files, request),
		handlePostMessageRoute: (request: AuthenticatedRequest) => handlePostMessageRoute(store, files, request),
		handleUploadAttachmentRoute: (request: AuthenticatedRequest) => handleUploadAttachmentRoute(store, files, request),
		handleRemoveAttachmentRoute: (request: AuthenticatedRequest) => handleRemoveAttachmentRoute(store, request),
		handleMarkReadRoute: (request: AuthenticatedRequest) => handleMarkReadRoute(store, request),
		handleSaveDraftRoute: (request: AuthenticatedRequest) => handleSaveDraftRoute(store, request),
	};
}
