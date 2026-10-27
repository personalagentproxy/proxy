import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, parseSchema, requirePresent} from '@proxy/utils';
import {AVATAR_COLORS, type Look, lookSchema} from '@proxy/utils/harness';
import {
	appendPersonMessage,
	createPersona,
	deletePersona,
	ensureMemberThread,
	type EntryRow,
	getMemberThread,
	getPersona,
	type LastMessage,
	listEntriesWithPending,
	listOpenJobs,
	listPersonas,
	type PersonaRow,
	type ThreadRow,
	updatePersona,
} from '@proxy/db/harness';
import {AGENT_NAME_MAX} from '@proxy/integrations';

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

const MAX_MESSAGE = 20_000;

/** A persona as the page lists it, whether the viewer may change it, and the last thing said in their conversation with it, cut to a line; null before anything was said. */
export type PersonaResponse = {id: string; name: string; look: Look; color: string; mayChange: boolean; lastMessage: {kind: 'person' | 'assistant'; text: string; at: string} | null};

/** A turn of the conversation as the page shows it: what the person said, or what the persona answered, which is what went wrong where its turn failed. What the persona did in between is in the activity log, not here. */
export type EntryResponse = {id: string; kind: 'person' | 'assistant'; text: string; isError: boolean; at: string};

/** The member's conversation with a persona: the persona, the thread, its turns, and what the persona is up to: busy on it, asleep until a time, or waiting for the person. */
export type ThreadLogResponse = {persona: PersonaResponse; thread: {id: string}; entries: EntryResponse[]; busy: boolean; sleepingUntil: string | null};

// How much of the last message the list shows.
const PREVIEW_CHARS = 120;

// The last message as a line of words: its Markdown marks dropped, its whitespace folded.
function preview(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/gm, '')
		.replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*_`~|]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, PREVIEW_CHARS);
}

// Whether the viewer may rename, reface or delete the persona: whoever made it, or the organization's owner (utils/manages.ts).
function managesPersona(viewer: OrgViewer, persona: PersonaRow): boolean {
	return manages(viewer, {ownerUserId: null, byId: persona.createdById});
}

function toPersona(viewer: OrgViewer, persona: PersonaRow & {lastMessage?: LastMessage | null}): PersonaResponse {
	const last = persona.lastMessage ?? null;
	return {
		id: persona.id,
		name: persona.name,
		look: persona.look,
		color: persona.color,
		mayChange: managesPersona(viewer, persona),
		lastMessage: last && {kind: last.kind, text: preview(last.text), at: last.createdAt.toISOString()},
	};
}

// A persona as the person makes or changes it: a name, and a head, a look in one of the colors.
const personaSchema = z.object({
	name: z.string().trim().pipe(z.string().min(1).max(AGENT_NAME_MAX)),
	look: lookSchema,
	color: z.enum(AVATAR_COLORS),
});

// The entries the person sees: the conversation, what they said and what the persona answered,
// not the calls, their results, the reports or the summaries the model reads.
function isShown(entry: EntryRow): entry is EntryRow & {kind: EntryResponse['kind']} {
	return entry.kind === 'person' || (entry.kind === 'assistant' && entry.text !== '');
}

function toEntry(entry: EntryRow & {kind: EntryResponse['kind']}): EntryResponse {
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

/** `GET /api/orgs/:org/chat/personas`: the organization's personas, in the order they were made, with the viewer's conversations. */
export function handleListPersonasRoute(request: AuthenticatedRequest): Promise<Result<{personas: PersonaResponse[]}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const personas = $(await listPersonas(viewer.orgId, viewer.userId));
		return {personas: personas.map((persona) => toPersona(viewer, persona))};
	});
}

/** `POST /api/orgs/:org/chat/personas` with `{name, look, color}`: a new persona, every member's, and the organization's built-in login with it where there is none yet. */
export function handleCreatePersonaRoute(request: AuthenticatedRequest): Promise<Result<{persona: PersonaResponse}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(parseSchema(personaSchema, request.body));
		$(await ensureBuiltInAgent(viewer.orgId));
		const made = $(await createPersona(viewer.orgId, viewer.userId, persona));
		return {persona: toPersona(viewer, made)};
	});
}

/** `PUT /api/orgs/:org/chat/personas/:personaId` with `{name, look, color}`: the persona renamed, or with another head. */
export function handleUpdatePersonaRoute(request: AuthenticatedRequest): Promise<Result<{persona: PersonaResponse}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(parseSchema(personaSchema, request.body));
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
export function handleGetThreadRoute(request: AuthenticatedRequest): Promise<Result<ThreadLogResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const persona = $(await requirePersona(viewer, request));
		const thread = $(await requireThread(viewer, persona));
		const [entries, jobs] = await Promise.all([listEntriesWithPending(thread.id), listOpenJobs(thread.id)]);
		const open = $(jobs);
		const now = Date.now();
		// Asleep when every open job is a tool job due later; the first to be due is when it wakes.
		const later = open.filter((job) => job.runAt.getTime() > now);
		const asleep = open.length > 0 && later.length === open.length;
		const first = later.map((job) => job.runAt.getTime()).sort((a, b) => a - b)[0];
		return {
			persona: toPersona(viewer, persona),
			thread: {id: thread.id},
			entries: $(entries).filter(isShown).map(toEntry),
			busy: open.length > 0 && !asleep,
			sleepingUntil: asleep && first !== undefined ? new Date(first).toISOString() : null,
		};
	});
}

const messageBodySchema = z.object({text: z.string().trim().min(1).max(MAX_MESSAGE)});

/** `POST /api/orgs/:org/chat/personas/:personaId/messages` with `{text}`: what the viewer says to the persona; it is woken. */
export function handlePostMessageRoute(request: AuthenticatedRequest): Promise<Result<{entry: EntryResponse}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireChat(request));
		const {text} = $(parseSchema(messageBodySchema, request.body));
		const persona = $(await requirePersona(viewer, request));
		const thread = $(await requireThread(viewer, persona));
		const entry = $(requirePresent($(await appendPersonMessage(thread.id, text)), ApiErr.notFound('thread', thread.id)));
		return {entry: toEntry({...entry, kind: 'person'})};
	});
}
