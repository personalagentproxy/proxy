import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, parseSchema, requirePresent} from '@proxy/utils';
import {AVATAR_COLORS, AVATAR_SHAPES, PERSONA_NAME_MAX, type ToolCall} from '@proxy/utils/harness';
import {appendPersonMessage, createThread, deleteThread, type EntryRow, getThread, type LastMessage, listEntries, listOpenJobs, listThreads, type ThreadRow, updateThread} from '@proxy/db/harness';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import {requireBuiltInAgent} from './built-in-agent';
import {createThreadTask} from './thread-task';

/**
 * The Chat page's routes: the person's threads with the built-in agent, each a persona they named
 * and gave a face, one thread's log, and what they say in it. Behind the `harness` experiment.
 * Nothing here runs the model: a message queues a job, and the worker (worker.ts) does the rest;
 * the page reads the log again as it goes.
 */

const MAX_MESSAGE = 20_000;

/** A thread as a persona, with the last thing said in it where the list shows that; null where nothing was said yet, or where it isn't shown. */
export type ThreadResponse = {id: string; createdAt: string; taskId: string; name: string; shape: string; color: string; lastMessage: {kind: 'person' | 'assistant'; text: string; at: string} | null};

export type EntryResponse = {id: string; kind: 'person' | 'assistant' | 'tool_result'; text: string; toolCalls: ToolCall[] | null; callId: string | null; isError: boolean; at: string};

/** The thread's log, and what the agent is up to: busy on it, asleep until a time, or waiting for the person. */
export type ThreadLogResponse = {thread: ThreadResponse; entries: EntryResponse[]; busy: boolean; sleepingUntil: string | null};

// How much of the last message the list shows.
const PREVIEW_CHARS = 120;

function toThread(thread: ThreadRow & {lastMessage?: LastMessage | null}): ThreadResponse {
	const last = thread.lastMessage ?? null;
	return {
		id: thread.id,
		createdAt: thread.createdAt.toISOString(),
		taskId: thread.taskId,
		name: thread.name,
		shape: thread.shape,
		color: thread.color,
		lastMessage: last && {kind: last.kind, text: last.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS), at: last.createdAt.toISOString()},
	};
}

// A persona as the person makes or changes it: a name, and an avatar from the catalog.
const personaSchema = z.object({
	name: z.string().trim().pipe(z.string().min(1).max(PERSONA_NAME_MAX)),
	shape: z.enum(AVATAR_SHAPES),
	color: z.enum(AVATAR_COLORS),
});

// The entries the person sees: the conversation, not the summaries the model reads it as.
function isShown(entry: EntryRow): entry is EntryRow & {kind: EntryResponse['kind']} {
	return entry.kind !== 'summary';
}

function toEntry(entry: EntryRow & {kind: EntryResponse['kind']}): EntryResponse {
	return {id: entry.id, kind: entry.kind, text: entry.text, toolCalls: entry.toolCalls, callId: entry.callId, isError: entry.isError, at: entry.createdAt.toISOString()};
}

function requireHarness(request: AuthenticatedRequest): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (!hasExperiment(request.user, 'harness')) {
			return $(Err(ApiErr.forbidden()));
		}
		return $(await requireUserOrgId(request));
	});
}

/** `GET /api/chat/threads`: the organization's threads, in the order they were made. */
export function handleListThreadsRoute(request: AuthenticatedRequest): Promise<Result<{threads: ThreadResponse[]}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireHarness(request));
		return {threads: $(await listThreads(orgId)).map(toThread)};
	});
}

/** `POST /api/chat/threads` with `{name, shape, color}`: a new thread as that persona, with the built-in agent made where the organization has none yet. */
export function handleCreateThreadRoute(request: AuthenticatedRequest): Promise<Result<{thread: ThreadResponse}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireHarness(request));
		const persona = $(parseSchema(personaSchema, request.body));
		const agent = $(await requireBuiltInAgent(orgId));
		const taskId = $(await createThreadTask(orgId, agent.agentId));
		return {thread: toThread($(await createThread({orgId, agentId: agent.agentId, taskId, ...persona})))};
	});
}

/** `PUT /api/chat/threads/:threadId` with `{name, shape, color}`: the persona renamed, or with another face. */
export function handleUpdateThreadRoute(request: AuthenticatedRequest): Promise<Result<{thread: ThreadResponse}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireHarness(request));
		const persona = $(parseSchema(personaSchema, request.body));
		const threadId = request.params.threadId ?? '';
		const thread = $(requirePresent($(await updateThread(orgId, threadId, persona)), ApiErr.notFound('thread', threadId)));
		return {thread: toThread(thread)};
	});
}

/** `DELETE /api/chat/threads/:threadId`: the persona and its whole conversation. */
export function handleDeleteThreadRoute(request: AuthenticatedRequest): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireHarness(request));
		const threadId = request.params.threadId ?? '';
		if (!$(await deleteThread(orgId, threadId))) {
			return $(Err(ApiErr.notFound('thread', threadId)));
		}
	});
}

/** `GET /api/chat/threads/:threadId`: the thread's log and whether the agent is busy on it. */
export function handleGetThreadRoute(request: AuthenticatedRequest): Promise<Result<ThreadLogResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireHarness(request));
		const threadId = request.params.threadId ?? '';
		const thread = $(requirePresent($(await getThread(orgId, threadId)), ApiErr.notFound('thread', threadId)));
		const [entries, jobs] = await Promise.all([listEntries(thread.id), listOpenJobs(thread.id)]);
		const open = $(jobs);
		const now = Date.now();
		// Asleep when every open job is a tool job due later; the first to be due is when it wakes.
		const later = open.filter((job) => job.runAt.getTime() > now);
		const asleep = open.length > 0 && later.length === open.length;
		const first = later.map((job) => job.runAt.getTime()).sort((a, b) => a - b)[0];
		return {
			thread: toThread(thread),
			entries: $(entries).filter(isShown).map(toEntry),
			busy: open.length > 0 && !asleep,
			sleepingUntil: asleep && first !== undefined ? new Date(first).toISOString() : null,
		};
	});
}

const messageBodySchema = z.object({text: z.string().trim().min(1).max(MAX_MESSAGE)});

/** `POST /api/chat/threads/:threadId/messages` with `{text}`: what the person says; the agent is woken. */
export function handlePostMessageRoute(request: AuthenticatedRequest): Promise<Result<{entry: EntryResponse}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireHarness(request));
		const {text} = $(parseSchema(messageBodySchema, request.body));
		const threadId = request.params.threadId ?? '';
		$(requirePresent($(await getThread(orgId, threadId)), ApiErr.notFound('thread', threadId)));
		const entry = $(requirePresent($(await appendPersonMessage(threadId, text)), ApiErr.notFound('thread', threadId)));
		return {entry: toEntry({...entry, kind: 'person'})};
	});
}
