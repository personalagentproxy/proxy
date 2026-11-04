import {Err, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, hasExperiment, requirePresent} from '@proxy/utils';
import {pendingToolCalls, readyForInference} from '@proxy/utils/harness';
import type {EntryRow, JobDetailRow, JobEventRow, ThreadRow} from '@proxy/db/harness';
import type {InspectedEntry, InspectedJob, InspectedJobEvent, InspectedThread, inspectionSchema, ModelRequest, ThreadState} from '@proxy/contracts/inspect';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {type OrgViewer, requireViewer} from '../utils/user-org';
import {COMPACT_AT_TOKENS, compactionCut, type SubAgent, toMessages, toTranscript} from './context';
import {MAX_TURNS_ALONE, SUMMARIZE, SUMMARIZE_NOW, turnsAlone} from './inference';
import {requireThread, toPersona} from './route';
import type {HarnessStore} from './store';
import {toolsFor} from './tool-surface';

/**
 * The inspector's routes, for whoever works on the built-in agent, behind the `debug` experiment
 * beside `harness`: the viewer's conversation with a persona as the harness has it, every thread
 * of it with its whole log, its jobs and what happened to each, and, for any answer of the model,
 * the request it was sent, rebuilt from the log with the functions the harness runs (context.ts)
 * and the system prompt the entry kept. The viewer sees their own conversations alone, as on the
 * Chat page: a conversation is theirs, whoever they are in the organization.
 */

/** What the inspector's routes need of the store. */
export type InspectStore = Pick<
	HarnessStore,
	'getPersona' | 'getMemberThread' | 'ensureMemberThread' | 'listSubAgents' | 'listEntriesWithPending' | 'listThreadJobs' | 'listJobEvents' | 'getEntry' | 'getJobThread' | 'listEntries'
>;

function toInspectedEntry(entry: EntryRow): InspectedEntry {
	return {
		id: entry.id,
		seq: entry.seq,
		kind: entry.kind,
		text: entry.text,
		toolCalls: entry.toolCalls,
		callId: entry.callId,
		isError: entry.isError,
		pending: entry.pending,
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		coversSeq: entry.coversSeq,
		hasSystem: entry.system !== null,
		jobId: entry.jobId,
		at: entry.createdAt.toISOString(),
	};
}

function toInspectedJob(job: JobDetailRow): InspectedJob {
	return {
		id: job.id,
		threadId: job.threadId,
		kind: job.kind,
		status: job.status,
		entryId: job.entryId,
		callId: job.callId,
		runAt: job.runAt.toISOString(),
		claimedBy: job.claimedBy,
		leaseExpiresAt: job.leaseExpiresAt?.toISOString() ?? null,
		attempts: job.attempts,
		error: job.error,
		createdAt: job.createdAt.toISOString(),
	};
}

function toInspectedEvent(event: JobEventRow): InspectedJobEvent {
	return {id: event.id, jobId: event.jobId, threadId: event.threadId, kind: event.kind, workerId: event.workerId, error: event.error, at: event.at.toISOString()};
}

// Where the thread stands, from the log the model reads: what is pending is not in it yet.
function stateOf(entries: EntryRow[]): ThreadState {
	const log = entries.filter((entry) => !entry.pending);
	const cut = compactionCut(log);
	const lastAnswer = log.findLast((entry) => entry.kind === 'assistant');
	return {
		ready: readyForInference(log),
		pendingCalls: pendingToolCalls(log),
		turnsAlone: turnsAlone(log),
		maxTurnsAlone: MAX_TURNS_ALONE,
		lastInputTokens: lastAnswer?.inputTokens ?? 0,
		compactAtTokens: COMPACT_AT_TOKENS,
		compactionCoversSeq: cut === null ? null : (log[cut - 1]?.seq ?? null),
	};
}

function requireInspector(request: AuthenticatedRequest): Promise<Result<OrgViewer, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(request));
		if (!hasExperiment(viewer, 'harness') || !hasExperiment(viewer, 'debug')) {
			return $(Err(ApiErr.forbidden()));
		}
		return viewer;
	});
}

// A thread the viewer may inspect: one of their own conversations, or a sub-agent started from one.
function mayInspect(viewer: OrgViewer, thread: ThreadRow): boolean {
	return thread.orgId === viewer.orgId && thread.userId === viewer.userId;
}

function inspectThread(store: InspectStore, thread: ThreadRow, jobs: JobDetailRow[], events: JobEventRow[]): Promise<Result<InspectedThread, ApiError>> {
	return Do(async ($) => {
		const entries = $(await store.listEntriesWithPending(thread.id));
		return {
			id: thread.id,
			parentThreadId: thread.parentThreadId,
			parentCallId: thread.parentCallId,
			title: thread.title,
			taskId: thread.taskId,
			createdAt: thread.createdAt.toISOString(),
			entries: entries.map(toInspectedEntry),
			jobs: jobs.filter((job) => job.threadId === thread.id).map(toInspectedJob),
			events: events.filter((event) => event.threadId === thread.id).map(toInspectedEvent),
			state: stateOf(entries),
		};
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/inspect`: the viewer's conversation with the persona as the harness has it, begun where there was none, as the Chat page begins it. */
function handleInspectThreadRoute(store: InspectStore, request: AuthenticatedRequest): Promise<Result<z.infer<typeof inspectionSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireInspector(request));
		const personaId = request.params.personaId ?? '';
		const persona = $(requirePresent($(await store.getPersona(viewer.orgId, personaId)), ApiErr.notFound('persona', personaId)));
		const conversation = $(await requireThread(store, viewer, persona));
		const now = new Date();
		const subAgents = $(await store.listSubAgents(conversation.id, now));
		const threads: ThreadRow[] = [conversation, ...subAgents];
		const ids = threads.map((thread) => thread.id);
		const [jobs, events] = await Promise.all([store.listThreadJobs(ids), store.listJobEvents(ids)]);
		const allJobs = $(jobs);
		const allEvents = $(events);
		const inspected: InspectedThread[] = [];
		for (const thread of threads) {
			inspected.push($(await inspectThread(store, thread, allJobs, allEvents)));
		}
		return {persona: toPersona(viewer, persona), now: now.toISOString(), threads: inspected};
	});
}

// The request behind an assistant entry: the log before it, as the model read it, behind the
// system prompt the entry kept. The sub-agents are the thread's as they are now: a message of one
// is led in by its call, which doesn't change.
function turnRequest(thread: ThreadRow, entry: EntryRow, log: EntryRow[], subAgents: SubAgent[]): ModelRequest {
	const before = log.filter((candidate) => candidate.seq < entry.seq);
	const system: ModelRequest['messages'] = entry.system === null ? [] : [{role: 'system', content: entry.system}];
	return {kind: 'turn', system: entry.system, messages: [...system, ...toMessages(before, subAgents, {clearOld: true})], tools: toolsFor(thread)};
}

// The request behind a summary entry: the log it covers, written out for the model to summarize.
function summaryRequest(entry: EntryRow, log: EntryRow[], subAgents: SubAgent[]): ModelRequest {
	const covered = log.filter((candidate) => candidate.seq <= (entry.coversSeq ?? -1));
	return {
		kind: 'summary',
		system: SUMMARIZE,
		messages: [
			{role: 'system', content: SUMMARIZE},
			{role: 'user', content: `${toTranscript(covered, subAgents)}\n\n${SUMMARIZE_NOW}`},
		],
		tools: [],
	};
}

/** `GET /api/orgs/:org/chat/inspect/entries/:entryId/request`: what the model was sent for an assistant or summary entry of one of the viewer's threads, rebuilt from the log; not found for any other entry. */
function handleInspectRequestRoute(store: InspectStore, request: AuthenticatedRequest): Promise<Result<ModelRequest, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireInspector(request));
		const entryId = request.params.entryId ?? '';
		const entry = $(await store.getEntry(entryId));
		const thread = $(requirePresent($(await store.getJobThread(entry.threadId)), ApiErr.notFound('thread', entry.threadId)));
		if (!mayInspect(viewer, thread)) {
			return $(Err(ApiErr.notFound('entry', entryId)));
		}
		const log = $(await store.listEntries(thread.id));
		// A conversation's log names its sub-agents; a sub-agent's has none of its own.
		const subAgents = thread.parentThreadId === null ? $(await store.listSubAgents(thread.id, new Date())) : [];
		if (entry.kind === 'assistant') {
			return turnRequest(thread, entry, log, subAgents);
		}
		if (entry.kind === 'summary') {
			return summaryRequest(entry, log, subAgents);
		}
		return $(Err(ApiErr.notFound('entry', entryId)));
	});
}

/** The inspector's routes, on the store. */
export function inspectRoutes(store: InspectStore) {
	return {
		handleInspectThreadRoute: (request: AuthenticatedRequest) => handleInspectThreadRoute(store, request),
		handleInspectRequestRoute: (request: AuthenticatedRequest) => handleInspectRequestRoute(store, request),
	};
}
