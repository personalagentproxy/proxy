import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, hasExperiment, requirePresent} from '@proxy/utils';
import {pendingToolCalls, readyForInference, type ToolCall} from '@proxy/utils/harness';
import {
	type EntryRow,
	getEntry,
	getJobThread,
	getMemberThread,
	getPersona,
	type JobDetailRow,
	type JobEventRow,
	listEntries,
	listEntriesWithPending,
	listJobEvents,
	listSubAgentThreads,
	listThreadJobs,
	type ThreadRow,
} from '@proxy/db/harness';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {type OrgViewer, requireViewer} from '../utils/user-org';
import {COMPACT_AT_TOKENS, compactionCut, toMessages, toTranscript} from './context';
import {MAX_TURNS_ALONE, SUMMARIZE, SUMMARIZE_NOW, turnsAlone} from './inference';
import type {ModelMessage, ModelTool} from './model';
import {type PersonaResponse, toPersona} from './persona-response';
import {toolsFor} from './tool-surface';

/**
 * The inspector's routes, for whoever works on the built-in agent, behind the `debug`
 * experiment beside `harness`: the viewer's conversation with a persona as the harness has it,
 * every thread of it with its whole log, its jobs and what happened to each, and, for any answer
 * of the model, the request it was sent, rebuilt from the log with the functions the harness runs
 * (context.ts) and the system prompt the entry kept. The viewer sees their own conversations
 * alone, as on the Chat page: a conversation is theirs, whoever they are in the organization.
 */

/** An entry of a thread's log, whole: every kind, what is pending too, with what the model's answer cost and whether its system prompt was kept, which `GET …/inspect/entries/:entryId/request` gives with the rest of the request. */
export type InspectedEntry = {
	id: string;
	seq: number;
	kind: EntryRow['kind'];
	text: string;
	toolCalls: ToolCall[] | null;
	callId: string | null;
	isError: boolean;
	pending: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	coversSeq: number | null;
	hasSystem: boolean;
	jobId: string | null;
	at: string;
};

/** A job as the queue has it, whatever its status. */
export type InspectedJob = {
	id: string;
	threadId: string;
	kind: JobDetailRow['kind'];
	status: JobDetailRow['status'];
	entryId: string | null;
	callId: string | null;
	runAt: string;
	claimedBy: string | null;
	leaseExpiresAt: string | null;
	attempts: number;
	error: string | null;
	createdAt: string;
};

/** What happened to a job, one row per happening. */
export type InspectedJobEvent = {id: string; jobId: string; threadId: string; kind: JobEventRow['kind']; workerId: string | null; error: string | null; at: string};

/** Where the thread stands for the harness: whether its log is ready for the model and what holds it back, how many steps the model took alone against the limit, and how close the log is to being summarized. */
export type ThreadState = {
	ready: boolean;
	pendingCalls: ToolCall[];
	turnsAlone: number;
	maxTurnsAlone: number;
	lastInputTokens: number;
	compactAtTokens: number;
	// The seq of the last entry a summary made now would cover; null when the log needs none.
	compactionCoversSeq: number | null;
};

/** A thread of the conversation: the conversation itself, or a sub-agent started from it. */
export type InspectedThread = {
	id: string;
	parentThreadId: string | null;
	parentCallId: string | null;
	title: string | null;
	taskId: string | null;
	finishedAt: string | null;
	createdAt: string;
	entries: InspectedEntry[];
	jobs: InspectedJob[];
	events: InspectedJobEvent[];
	state: ThreadState;
};

/** The viewer's conversation with a persona, whole: the conversation's thread first, then every sub-agent started from it, oldest first. */
export type InspectionResponse = {persona: PersonaResponse; now: string; threads: InspectedThread[]};

/** What the model was sent for an entry: the system prompt as kept (null where the answer was written without the model), the messages and the tools, rebuilt from the log as it was. */
export type RequestResponse = {kind: 'turn' | 'summary'; system: string | null; messages: ModelMessage[]; tools: ModelTool[]};

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

async function inspectThread(thread: ThreadRow, jobs: JobDetailRow[], events: JobEventRow[]): Promise<Result<InspectedThread, ApiError>> {
	return Do(async ($) => {
		const entries = $(await listEntriesWithPending(thread.id));
		return {
			id: thread.id,
			parentThreadId: thread.parentThreadId,
			parentCallId: thread.parentCallId,
			title: thread.title,
			taskId: thread.taskId,
			finishedAt: thread.finishedAt?.toISOString() ?? null,
			createdAt: thread.createdAt.toISOString(),
			entries: entries.map(toInspectedEntry),
			jobs: jobs.filter((job) => job.threadId === thread.id).map(toInspectedJob),
			events: events.filter((event) => event.threadId === thread.id).map(toInspectedEvent),
			state: stateOf(entries),
		};
	});
}

/** `GET /api/orgs/:org/chat/personas/:personaId/inspect`: the viewer's conversation with the persona as the harness has it; not found before they have one. */
export function handleInspectThreadRoute(request: AuthenticatedRequest): Promise<Result<InspectionResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireInspector(request));
		const personaId = request.params.personaId ?? '';
		const persona = $(requirePresent($(await getPersona(viewer.orgId, personaId)), ApiErr.notFound('persona', personaId)));
		const conversation = $(requirePresent($(await getMemberThread(persona.id, viewer.userId)), ApiErr.notFound('thread', persona.id)));
		const subAgents = $(await listSubAgentThreads(conversation.id));
		const threads = [conversation, ...subAgents];
		const ids = threads.map((thread) => thread.id);
		const [jobs, events] = await Promise.all([listThreadJobs(ids), listJobEvents(ids)]);
		const allJobs = $(jobs);
		const allEvents = $(events);
		const inspected: InspectedThread[] = [];
		for (const thread of threads) {
			inspected.push($(await inspectThread(thread, allJobs, allEvents)));
		}
		return {persona: toPersona(viewer, persona), now: new Date().toISOString(), threads: inspected};
	});
}

// The request behind an assistant entry: the log before it, as the model read it, behind the
// system prompt the entry kept.
function turnRequest(thread: ThreadRow, entry: EntryRow, log: EntryRow[]): RequestResponse {
	const before = log.filter((candidate) => candidate.seq < entry.seq);
	const system: ModelMessage[] = entry.system === null ? [] : [{role: 'system', content: entry.system}];
	return {kind: 'turn', system: entry.system, messages: [...system, ...toMessages(before, {clearOld: true})], tools: toolsFor(thread)};
}

// The request behind a summary entry: the log it covers, written out for the model to summarize.
function summaryRequest(entry: EntryRow, log: EntryRow[]): RequestResponse {
	const covered = log.filter((candidate) => candidate.seq <= (entry.coversSeq ?? -1));
	return {
		kind: 'summary',
		system: SUMMARIZE,
		messages: [
			{role: 'system', content: SUMMARIZE},
			{role: 'user', content: `${toTranscript(covered)}\n\n${SUMMARIZE_NOW}`},
		],
		tools: [],
	};
}

/** `GET /api/orgs/:org/chat/inspect/entries/:entryId/request`: what the model was sent for an assistant or summary entry of one of the viewer's threads, rebuilt from the log; not found for any other entry. */
export function handleInspectRequestRoute(request: AuthenticatedRequest): Promise<Result<RequestResponse, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireInspector(request));
		const entryId = request.params.entryId ?? '';
		const entry = $(await getEntry(entryId));
		const thread = $(requirePresent($(await getJobThread(entry.threadId)), ApiErr.notFound('thread', entry.threadId)));
		if (!mayInspect(viewer, thread)) {
			return $(Err(ApiErr.notFound('entry', entryId)));
		}
		const log = $(await listEntries(thread.id));
		if (entry.kind === 'assistant') {
			return turnRequest(thread, entry, log);
		}
		if (entry.kind === 'summary') {
			return summaryRequest(entry, log);
		}
		return $(Err(ApiErr.notFound('entry', entryId)));
	});
}
