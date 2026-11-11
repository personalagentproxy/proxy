import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, parseSchema, requirePresent} from '@proxy/utils';
import {
	callArguments,
	CREATE_SUBAGENT_TOOL,
	parentMessageArgs,
	preview,
	SEND_TO_PARENT_TOOL,
	SEND_TO_SUBAGENT_TOOL,
	subAgentMessageArgs,
	threadState,
	toAvatarColor,
	type ToolCall,
} from '@proxy/utils/harness';
import type {EntryRow, LastMessage, Persona, PersonaModel, PersonaRow, SubAgentRow, ThreadRow} from '@proxy/db/harness';
import {
	type ChatEntry,
	type chatAnswersSchema,
	type ChatHarness,
	type ChatMessage,
	type ChatPersona,
	type ChatTask,
	markReadBodySchema,
	personaBodySchema,
	pinTaskBodySchema,
	type personaAnswerSchema,
	type personaListSchema,
	postMessageBodySchema,
	type postedMessageSchema,
	saveDraftBodySchema,
	type TaskChat,
	type TaskChatEntry,
	type ThreadLog,
} from '@proxy/contracts/harness';

import {chosenFor, harnessesOf, type HarnessRegistry} from '../backends/harness';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {manages} from '../utils/manages';
import {type OrgViewer, requireViewer} from '../utils/user-org';
import {ensureBuiltInAgent} from './built-in-agent';
import {STOPPED_NOTE} from './conversation';
import type {HarnessStore} from './store';

/**
 * The Chat page's routes, under the organization: the personas the member sees, their own and
 * General, which every member does, each named and given a head, all acting through the
 * organization's one built-in agent login, and the member's own conversation with each, its log,
 * and what it and its sub-agents are up to. Each sub-agent is a task to the member, shown where it
 * was started, with a chat of its own: what it and the persona said to each other, and what the
 * member writes to it there. A persona
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
	| 'listShownSubAgentEntries'
	| 'listSubAgents'
	| 'listOpenJobs'
	| 'appendPersonMessage'
	| 'messageSubAgentDirectly'
	| 'listPinnedTasks'
	| 'setTaskPinned'
	| 'markThreadRead'
	| 'getThreadDraft'
	| 'saveThreadDraft'
>;

/** The harnesses this server has, read where a route needs them, so that nothing is made as the routes are mounted. */
export type Harnesses = () => HarnessRegistry;

// Whether the viewer may rename, reface, switch the harness or the model of, or delete the persona: their own, or one every member sees that they made or whose organization they own (utils/manages.ts).
function managesPersona(viewer: OrgViewer, persona: PersonaRow): boolean {
	return manages(viewer, {ownerUserId: persona.ownerUserId, byId: persona.createdById});
}

function toPersona(harnesses: Harnesses, viewer: OrgViewer, persona: PersonaRow & {lastMessage?: LastMessage | null; draft?: string | null}): ChatPersona {
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
		shared: persona.ownerUserId === null,
		mayChange: managesPersona(viewer, persona),
		lastMessage: last && {kind: last.kind, text: preview(last.text), at: last.createdAt.toISOString()},
		draft: persona.draft ? preview(persona.draft) : null,
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

// The calls the person sees in their conversation, as the tasks the persona started and what it
// sent them; and in a task's chat, what the task told the persona as it went.
const CONVERSATION_CALLS = [CREATE_SUBAGENT_TOOL, SEND_TO_SUBAGENT_TOOL];
const TASK_CALLS = [SEND_TO_PARENT_TOOL];

function toMessage(entry: EntryRow & {kind: ChatMessage['kind']}): ChatMessage {
	return {id: entry.id, kind: entry.kind, text: entry.text, isError: entry.isError, at: entry.createdAt.toISOString()};
}

function toTask(subAgent: SubAgentRow): ChatTask {
	return {id: subAgent.id, title: subAgent.title ?? ''};
}

// What a call of the persona's shows in the conversation, as the answer that made it says: a task
// it started, where one was, and a message to a task of the conversation's.
function callEntries(entry: EntryRow, call: ToolCall, subAgents: SubAgentRow[]): ChatEntry[] {
	const id = `${entry.id}:${call.id}`;
	const at = entry.createdAt.toISOString();
	if (call.name === CREATE_SUBAGENT_TOOL) {
		const started = subAgents.find((subAgent) => subAgent.parentCallId === call.id);
		return started ? [{id, kind: 'task', task: toTask(started), at}] : [];
	}
	if (call.name !== SEND_TO_SUBAGENT_TOOL) {
		return [];
	}
	const sent = subAgentMessageArgs(callArguments(call));
	const to = subAgents.find((subAgent) => subAgent.id === sent?.subagent);
	return to ? [{id, kind: 'sent', task: toTask(to), at}] : [];
}

// What an entry of the conversation shows (db/harness listShownEntries): what the person said;
// what the persona answered in words, then the tasks it started and the messages it sent them.
function conversationEntries(subAgents: SubAgentRow[]): (entry: EntryRow) => ChatEntry[] {
	return (entry) => {
		if (entry.kind === 'person') {
			return [toMessage({...entry, kind: 'person'})];
		}
		if (entry.kind !== 'assistant') {
			return [];
		}
		const said = entry.text === '' ? [] : [toMessage({...entry, kind: 'assistant'})];
		return [...said, ...(entry.toolCalls ?? []).flatMap((call) => callEntries(entry, call, subAgents))];
	};
}

// What an entry of a task's chat shows (db/harness listShownSubAgentEntries): what the persona
// said to it, or the person; what it answered, without the calls it worked through, and what it
// told the persona as it went; and its failures, which the conversation's log has, without the
// note that it stopped, which the chat shows otherwise.
function taskChatEntries(subAgent: SubAgentRow): (entry: EntryRow) => TaskChatEntry[] {
	return (entry) => {
		const at = entry.createdAt.toISOString();
		if (entry.threadId !== subAgent.id) {
			return [{id: entry.id, from: 'task', text: entry.text.replace(`\n\n${STOPPED_NOTE}`, ''), isError: true, at}];
		}
		if (entry.kind === 'person') {
			return [{id: entry.id, from: entry.direct ? 'person' : 'persona', text: entry.text, isError: false, at}];
		}
		if (entry.kind !== 'assistant') {
			return [];
		}
		const calls = entry.toolCalls ?? [];
		if (calls.length === 0) {
			return [{id: entry.id, from: 'task', text: entry.text, isError: entry.isError, at}];
		}
		return calls.flatMap((call) => {
			const told = call.name === SEND_TO_PARENT_TOOL ? parentMessageArgs(callArguments(call)) : null;
			return told ? [{id: `${entry.id}:${call.id}`, from: 'task' as const, text: told.text, isError: false, at}] : [];
		});
	};
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

/** `GET /api/orgs/:org/chat/personas`: the organization's personas the viewer sees, their own and those every member does, the one last active in the viewer's conversation first, with the viewer's conversations, the tasks they pinned in them, and the harnesses the server has for one to run on; a General one, every member's, is made where there is none, after the viewer's own, so a message that names no agent always has one to go to. */
function handleListPersonasRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaListSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const [found, pinned] = await Promise.all([store.listPersonas(viewer.orgId, viewer.userId), store.listPinnedTasks(viewer.orgId, viewer.userId)]);
		const personas = $(found);
		const offered = toHarnesses(harnesses());
		const pinnedTasks = $(pinned).map(({id, personaId, title}) => ({id, personaId, title}));
		const listed = personas.map((persona) => toPersona(harnesses, viewer, persona));
		if (personas.some((persona) => persona.ownerUserId === null)) {
			return {personas: listed, pinnedTasks, harnesses: offered};
		}
		const general = $(await store.ensureFirstPersona(viewer.orgId));
		return {personas: [...listed, toPersona(harnesses, viewer, general)], pinnedTasks, harnesses: offered};
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

/** `POST /api/orgs/:org/chat/personas` with `{name, look, color, harness?, chatModel?}`: a new persona, the viewer's own, and the organization's built-in login with it where there is none yet. */
function handleCreatePersonaRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(readPersona(harnesses, request, null));
		$(await ensureBuiltInAgent(viewer.orgId));
		const made = $(await store.createPersona(viewer.orgId, viewer.userId, persona));
		return {persona: toPersona(harnesses, viewer, made)};
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId` with `{name, look, color, harness?, chatModel?}`: the persona renamed, with another head, or switched to another harness or model from its next turn on, every conversation with it and its sub-agents'. */
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

/** `DELETE /api/orgs/:org/chat/personas/:personaId`: the persona, with every conversation with it. */
function handleDeletePersonaRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(await requireManagedPersona(store, viewer, request));
		if (!$(await store.deletePersona(viewer.orgId, persona.id))) {
			return $(Err(ApiErr.notFound('persona', persona.id)));
		}
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/thread`: the viewer's conversation with the persona, begun where there was none, what they said while it was answering at the end, the tasks the persona started in it and what it sent them, whether the persona is busy on it, its sub-agents included, and what they typed in it and haven't sent. */
function handleGetThreadRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<ThreadLog, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireThread(store, viewer, persona));
		const now = new Date();
		const [entries, jobs, draft, subAgents] = await Promise.all([
			store.listShownEntries(thread.id, CONVERSATION_CALLS),
			store.listOpenJobs(thread.id),
			store.getThreadDraft(thread.id),
			store.listSubAgents(thread.id, now),
		]);
		// The conversation's and its sub-agents' jobs together: busy while any of them is at work.
		const state = threadState($(jobs), now);
		return {
			persona: toPersona(harnesses, viewer, persona),
			entries: $(entries).flatMap(conversationEntries($(subAgents))),
			busy: state.kind === 'working',
			draft: $(draft),
		};
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/messages` with `{text}`: what the viewer says to the persona; it is woken. */
function handlePostMessageRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<z.infer<typeof postedMessageSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const {text} = $(parseSchema(postMessageBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireThread(store, viewer, persona));
		const entry = $(requirePresent($(await store.appendPersonMessage(thread.id, text)), ApiErr.notFound('thread', thread.id)));
		return {entry: toMessage({...entry, kind: 'person'})};
	});
}

// The viewer's conversation with the persona in the address, which a task is of; never begun: a
// viewer without one has no task in it.
function requireExistingThread(store: ChatStore, viewer: OrgViewer, persona: PersonaRow, taskId: string): Promise<Result<ThreadRow, ApiError>> {
	return Do(async ($) => {
		return $(requirePresent($(await store.getMemberThread(persona.id, viewer.userId)), ApiErr.notFound('task', taskId)));
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/tasks/:taskId`: a task the persona started in the viewer's conversation with it, as its chat shows it: what it is up to, and what it, the persona and the viewer said in it. */
function handleGetTaskRoute(store: ChatStore, harnesses: Harnesses, request: AuthenticatedRequest): Promise<Result<TaskChat, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const taskId = request.params.taskId ?? '';
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireExistingThread(store, viewer, persona, taskId));
		const subAgents = $(await store.listSubAgents(thread.id, new Date()));
		const subAgent = $(requirePresent(subAgents.find((candidate) => candidate.id === taskId) ?? null, ApiErr.notFound('task', taskId)));
		const entries = $(await store.listShownSubAgentEntries(subAgent, TASK_CALLS));
		return {
			persona: toPersona(harnesses, viewer, persona),
			task: toTask(subAgent),
			busy: subAgent.state.kind === 'working',
			activityTaskId: subAgent.taskId,
			entries: entries.flatMap(taskChatEntries(subAgent)),
		};
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/tasks/:taskId/messages` with `{text}`: what the viewer writes to a task of their conversation with the persona, in its chat; the task takes it up, and the persona is told, but not woken by it: the task's answer wakes it. */
function handlePostTaskMessageRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const taskId = request.params.taskId ?? '';
		const {text} = $(parseSchema(postMessageBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireExistingThread(store, viewer, persona, taskId));
		if (!$(await store.messageSubAgentDirectly(thread.id, taskId, text))) {
			return $(Err(ApiErr.notFound('task', taskId)));
		}
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId/draft` with `{text}`: what the viewer has typed to the persona and not sent, kept in place of what was; nothing but whitespace forgets it. */
function handleSaveDraftRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const {text} = $(parseSchema(saveDraftBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireThread(store, viewer, persona));
		if (!$(await store.saveThreadDraft(thread.id, text.trim() === '' ? null : text))) {
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

/** `PUT /api/orgs/:org/chat/personas/:personaId/tasks/:taskId/pin` with `{pinned}`: a task of the viewer's conversation with the persona pinned to the list under it, or unpinned. */
function handlePinTaskRoute(store: ChatStore, request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const taskId = request.params.taskId ?? '';
		const {pinned} = $(parseSchema(pinTaskBodySchema, request.body));
		const persona = $(await requirePersona(store, viewer, request));
		const thread = $(await requireExistingThread(store, viewer, persona, taskId));
		if (!$(await store.setTaskPinned(thread.id, taskId, pinned))) {
			return $(Err(ApiErr.notFound('task', taskId)));
		}
	});
}

/** The Chat page's routes, on the store and the harnesses the server has. */
export function chatRoutes(store: ChatStore, harnesses: Harnesses) {
	return {
		handleListPersonasRoute: (request: AuthenticatedRequest) => handleListPersonasRoute(store, harnesses, request),
		handleListAnswersRoute: (request: AuthenticatedRequest) => handleListAnswersRoute(store, request),
		handleCreatePersonaRoute: (request: AuthenticatedRequest) => handleCreatePersonaRoute(store, harnesses, request),
		handleUpdatePersonaRoute: (request: AuthenticatedRequest) => handleUpdatePersonaRoute(store, harnesses, request),
		handleDeletePersonaRoute: (request: AuthenticatedRequest) => handleDeletePersonaRoute(store, request),
		handleGetThreadRoute: (request: AuthenticatedRequest) => handleGetThreadRoute(store, harnesses, request),
		handlePostMessageRoute: (request: AuthenticatedRequest) => handlePostMessageRoute(store, request),
		handleGetTaskRoute: (request: AuthenticatedRequest) => handleGetTaskRoute(store, harnesses, request),
		handlePostTaskMessageRoute: (request: AuthenticatedRequest) => handlePostTaskMessageRoute(store, request),
		handlePinTaskRoute: (request: AuthenticatedRequest) => handlePinTaskRoute(store, request),
		handleMarkReadRoute: (request: AuthenticatedRequest) => handleMarkReadRoute(store, request),
		handleSaveDraftRoute: (request: AuthenticatedRequest) => handleSaveDraftRoute(store, request),
	};
}
