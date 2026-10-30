import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, parseSchema, requirePresent} from '@proxy/utils';
import {preview, toAvatarColor} from '@proxy/utils/harness';
import {
	appendPersonMessage,
	createPersona,
	deletePersona,
	ensureFirstPersona,
	ensureMemberThread,
	type EntryRow,
	getMemberThread,
	getPersona,
	type LastMessage,
	listOpenJobs,
	listPersonas,
	listShownEntries,
	type PersonaRow,
	type ThreadRow,
	updatePersona,
} from '@proxy/db/harness';
import {
	type ChatEntry,
	type ChatPersona,
	personaBodySchema,
	type personaAnswerSchema,
	type personaListSchema,
	postMessageBodySchema,
	type postedMessageSchema,
	type ThreadLog,
} from '@proxy/contracts/harness';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {manages} from '../utils/manages';
import {type OrgViewer, requireViewer} from '../utils/user-org';
import {ensureBuiltInAgent} from './built-in-agent';

/**
 * The Chat page's routes, under the organization: its personas, which every member sees, each
 * named and given a head, all acting through the organization's one built-in agent login, and the
 * member's own conversation with each, its log, the sub-agents started from it, and what they say
 * in it. Behind the `harness` experiment. Nothing here runs the model: a message queues a job, and
 * the worker (worker.ts) does the rest; the page reads the log again as it goes.
 */

// Whether the viewer may rename, reface or delete the persona: whoever made it, or the organization's owner (utils/manages.ts).
function managesPersona(viewer: OrgViewer, persona: PersonaRow): boolean {
	return manages(viewer, {ownerUserId: null, byId: persona.createdById});
}

function toPersona(viewer: OrgViewer, persona: PersonaRow & {lastMessage?: LastMessage | null}): ChatPersona {
	const last = persona.lastMessage ?? null;
	return {
		id: persona.id,
		name: persona.name,
		look: persona.look,
		color: toAvatarColor(persona.color),
		mayChange: managesPersona(viewer, persona),
		lastMessage: last && {kind: last.kind, text: preview(last.text), at: last.createdAt.toISOString()},
	};
}

// The entries the person sees (db/harness listShownEntries), as their kinds, for the response.
function isShown(entry: EntryRow): entry is EntryRow & {kind: ChatEntry['kind']} {
	return entry.kind === 'person' || (entry.kind === 'assistant' && entry.text !== '');
}

function toEntry(entry: EntryRow & {kind: ChatEntry['kind']}): ChatEntry {
	return {id: entry.id, kind: entry.kind, text: entry.text, isError: entry.isError, at: entry.createdAt.toISOString()};
}

function requireChat(request: AuthenticatedRequest): Promise<Result<OrgViewer, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		if (!hasExperiment(viewer, 'harness')) {
			return $(Err(ApiErr.forbidden()));
		}
		return viewer;
	});
}

// The persona in the address, one of the organization's.
function requirePersona(viewer: OrgViewer, request: AuthenticatedRequest): Promise<Result<PersonaRow, ApiError>> {
	return Do(async ($) => {
		const personaId = request.params.personaId ?? '';
		return $(requirePresent($(await getPersona(viewer.orgId, personaId)), ApiErr.notFound('persona', personaId)));
	});
}

// The persona in the address, which the viewer may change; forbidden for one they only talk to.
function requireManagedPersona(viewer: OrgViewer, request: AuthenticatedRequest): Promise<Result<PersonaRow, ApiError>> {
	return Do(async ($) => {
		const persona = $(await requirePersona(viewer, request));
		if (!managesPersona(viewer, persona)) {
			return $(Err(ApiErr.forbidden()));
		}
		return persona;
	});
}

// The viewer's conversation with the persona, begun the first time, through the organization's
// built-in login, made with it where there is none yet.
function requireThread(viewer: OrgViewer, persona: PersonaRow): Promise<Result<ThreadRow, ApiError>> {
	return Do(async ($) => {
		const existing = $(await getMemberThread(persona.id, viewer.userId));
		if (existing) {
			return existing;
		}
		const login = $(await ensureBuiltInAgent(viewer.orgId));
		return $(await ensureMemberThread({orgId: viewer.orgId, agentId: login.id, personaId: persona.id, userId: viewer.userId}));
	});
}

/** `GET /api/orgs/:org/chat/personas`: the organization's personas, in the order they were made, with the viewer's conversations; a General one is made where it has none. */
export function handleListPersonasRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaListSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const personas = $(await listPersonas(viewer.orgId, viewer.userId));
		if (personas.length > 0) {
			return {personas: personas.map((persona) => toPersona(viewer, persona))};
		}
		const first = $(await ensureFirstPersona(viewer.orgId));
		return {personas: [toPersona(viewer, first)]};
	});
}

/** `POST /api/orgs/:org/chat/personas` with `{name, look, color}`: a new persona, every member's, and the organization's built-in login with it where there is none yet. */
export function handleCreatePersonaRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(parseSchema(personaBodySchema, request.body));
		$(await ensureBuiltInAgent(viewer.orgId));
		const made = $(await createPersona(viewer.orgId, viewer.userId, persona));
		return {persona: toPersona(viewer, made)};
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId` with `{name, look, color}`: the persona renamed, or with another head. */
export function handleUpdatePersonaRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof personaAnswerSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(parseSchema(personaBodySchema, request.body));
		const existing = $(await requireManagedPersona(viewer, request));
		if (!$(await updatePersona(viewer.orgId, existing.id, persona))) {
			return $(Err(ApiErr.notFound('persona', existing.id)));
		}
		return {persona: toPersona(viewer, {...existing, ...persona})};
	});
}

/** `DELETE /api/orgs/:org/chat/personas/:personaId`: the persona, with every member's conversation with it. */
export function handleDeletePersonaRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(await requireManagedPersona(viewer, request));
		if (!$(await deletePersona(viewer.orgId, persona.id))) {
			return $(Err(ApiErr.notFound('persona', persona.id)));
		}
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/thread`: the viewer's conversation with the persona, begun where there was none, what they said while it was answering at the end, and whether the persona is busy on it, its sub-agents included. */
export function handleGetThreadRoute(request: AuthenticatedRequest): Promise<Result<ThreadLog, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(await requirePersona(viewer, request));
		const thread = $(await requireThread(viewer, persona));
		const [entries, jobs] = await Promise.all([listShownEntries(thread.id), listOpenJobs(thread.id)]);
		const open = $(jobs);
		const now = Date.now();
		// Asleep when every open job is a sleep, a tool job due later; the first to be due is when
		// it wakes. A turn of the model to be tried again later is work under way, not sleep.
		const sleeping = open.filter((job) => job.kind === 'tool' && job.runAt.getTime() > now);
		const asleep = open.length > 0 && sleeping.length === open.length;
		const first = sleeping.map((job) => job.runAt.getTime()).sort((a, b) => a - b)[0];
		return {
			persona: toPersona(viewer, persona),
			entries: $(entries).filter(isShown).map(toEntry),
			busy: open.length > 0 && !asleep,
			sleepingUntil: asleep && first !== undefined ? new Date(first).toISOString() : null,
		};
	});
}

/** `POST /api/orgs/:org/chat/personas/:personaId/messages` with `{text}`: what the viewer says to the persona; it is woken. */
export function handlePostMessageRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof postedMessageSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const {text} = $(parseSchema(postMessageBodySchema, request.body));
		const persona = $(await requirePersona(viewer, request));
		const thread = $(await requireThread(viewer, persona));
		const entry = $(requirePresent($(await appendPersonMessage(thread.id, text)), ApiErr.notFound('thread', thread.id)));
		return {entry: toEntry({...entry, kind: 'person'})};
	});
}
