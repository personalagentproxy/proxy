import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, parseSchema, requirePresent} from '@proxy/utils';
import type {ToolCall} from '@proxy/utils/harness';
import {appendPersonMessage, createThread, type EntryRow, getThread, listEntries, listOpenJobs, listThreads, type ThreadRow} from '@proxy/db/harness';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireUserOrgId} from '../utils/user-org';
import {requireBuiltInAgent} from './built-in-agent';
import {createThreadTask} from './thread-task';

/**
 * The Chat page's routes: the person's threads with the built-in agent, one thread's log, and
 * what they say in it. Behind the `harness` experiment. Nothing here runs the model: a message
 * queues a job, and the worker (worker.ts) does the rest; the page reads the log again as it goes.
 */

const MAX_MESSAGE = 20_000;

export type ThreadResponse = {id: string; createdAt: string; taskId: string; title: string | null};

export type EntryResponse = {id: string; kind: 'person' | 'assistant' | 'tool_result'; text: string; toolCalls: ToolCall[] | null; callId: string | null; isError: boolean; at: string};

/** The thread's log, and what the agent is up to: busy on it, asleep until a time, or waiting for the person. */
export type ThreadLogResponse = {thread: ThreadResponse; entries: EntryResponse[]; busy: boolean; sleepingUntil: string | null};

function toThread(thread: ThreadRow & {title?: string | null}): ThreadResponse {
	return {id: thread.id, createdAt: thread.createdAt.toISOString(), taskId: thread.taskId, title: thread.title ?? null};
}

function toEntry(entry: EntryRow): EntryResponse {
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

/** `GET /api/chat/threads`: the organization's threads, newest first. */
export function handleListThreadsRoute(request: AuthenticatedRequest): Promise<Result<{threads: ThreadResponse[]}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireHarness(request));
		return {threads: $(await listThreads(orgId)).map(toThread)};
	});
}

/** `POST /api/chat/threads`: a new thread, with the built-in agent made where the organization has none yet. */
export function handleCreateThreadRoute(request: AuthenticatedRequest): Promise<Result<{thread: ThreadResponse}, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireHarness(request));
		const agent = $(await requireBuiltInAgent(orgId));
		const taskId = $(await createThreadTask(orgId, agent.agentId));
		return {thread: toThread($(await createThread({orgId, agentId: agent.agentId, taskId})))};
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
			entries: $(entries).map(toEntry),
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
		return {entry: toEntry(entry)};
	});
}
