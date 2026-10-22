import type {AgentEntryKind, AgentJobKind, AgentJobStatus, Prisma} from '@prisma/client';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';
import {type LogEntry, pendingToolCalls, type ToolCall} from '@proxy/utils/harness';

import {db} from '.';

/**
 * The built-in agent's threads, their logs and their jobs. Every change to a thread's log or its
 * jobs is made with the thread's row locked, so a result landing and the model being run on the
 * log never race: either the inference job sees the result, or the result sees no job and queues
 * one. A worker's write is fenced by its lease: it goes through only while the job is still its.
 */

export type ThreadRow = {
	id: string;
	orgId: string;
	agentId: string;
	taskId: string;
	// The persona the thread is shown as: its name, and its avatar's shape and color.
	name: string;
	shape: string;
	color: string;
	createdAt: Date;
};

/** What makes a thread a persona: its name and its avatar. */
export type Persona = {name: string; shape: string; color: string};

export type EntryRow = LogEntry & {
	id: string;
	seq: number;
	threadId: string;
	isError: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	// A summary entry's reach: the seq of the last entry it stands for.
	coversSeq: number | null;
	createdAt: Date;
};

export type JobRow = {
	id: string;
	threadId: string;
	kind: AgentJobKind;
	status: AgentJobStatus;
	entryId: string | null;
	callId: string | null;
	runAt: Date;
	claimedBy: string | null;
	attempts: number;
};

const threadSelect = {
	id: true,
	orgId: true,
	agentId: true,
	taskId: true,
	name: true,
	shape: true,
	color: true,
	createdAt: true,
} as const;

const entrySelect = {
	id: true,
	seq: true,
	threadId: true,
	kind: true,
	text: true,
	toolCalls: true,
	callId: true,
	isError: true,
	inputTokens: true,
	outputTokens: true,
	coversSeq: true,
	createdAt: true,
} as const;

const jobSelect = {
	id: true,
	threadId: true,
	kind: true,
	status: true,
	entryId: true,
	callId: true,
	runAt: true,
	claimedBy: true,
	attempts: true,
} as const;

type EntryRecord = Prisma.AgentEntryGetPayload<{select: typeof entrySelect}>;

type Tx = Prisma.TransactionClient;

function toEntry(entry: EntryRecord): EntryRow {
	return {
		...entry,
		toolCalls: entry.toolCalls === null ? null : (JSON.parse(entry.toolCalls) as ToolCall[]),
	};
}

/** A new thread for the person's organization, as the persona given, its calls made for `taskId`. */
export async function createThread(
	data: {orgId: string; agentId: string; taskId: string} & Persona,
): Promise<Result<ThreadRow, ApiError>> {
	return wrapDb(() => db.agentThread.create({data, select: threadSelect}));
}

/** Renames the thread's persona or changes its avatar; `Ok(null)` means no such thread in the organization. */
export async function updateThread(
	orgId: string,
	threadId: string,
	persona: Persona,
): Promise<Result<ThreadRow | null, ApiError>> {
	return wrapDb(async () => {
		const {count} = await db.agentThread.updateMany({where: {id: threadId, orgId}, data: persona});
		if (count === 0) {
			return null;
		}
		return db.agentThread.findUnique({where: {id: threadId}, select: threadSelect});
	});
}

/** Deletes the thread with its log and jobs; `Ok(false)` means no such thread in the organization. */
export async function deleteThread(
	orgId: string,
	threadId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.agentThread.deleteMany({where: {id: threadId, orgId}}))).map(
		({count}) => count > 0,
	);
}

/** The last thing said in a thread, by the person or the agent: what the list shows under the name. */
export type LastMessage = {kind: 'person' | 'assistant'; text: string; createdAt: Date};

/** The organization's threads, in the order they were made, each with the last thing said in it. */
export async function listThreads(
	orgId: string,
): Promise<Result<Array<ThreadRow & {lastMessage: LastMessage | null}>, ApiError>> {
	return (
		await wrapDb(() =>
			db.agentThread.findMany({
				where: {orgId},
				select: {
					...threadSelect,
					// The agent's turns that only made calls say nothing, so the last with words.
					entries: {
						where: {kind: {in: ['person', 'assistant']}, text: {not: ''}},
						orderBy: {seq: 'desc'},
						take: 1,
						select: {kind: true, text: true, createdAt: true},
					},
				},
				orderBy: {createdAt: 'asc'},
			}),
		)
	).map((threads) =>
		threads.map(({entries, ...thread}) => {
			const last = entries[0];
			return {
				...thread,
				lastMessage:
					last && (last.kind === 'person' || last.kind === 'assistant')
						? {kind: last.kind, text: last.text, createdAt: last.createdAt}
						: null,
			};
		}),
	);
}

/** `Ok(null)` means no such thread in the organization. */
export async function getThread(
	orgId: string,
	threadId: string,
): Promise<Result<ThreadRow | null, ApiError>> {
	return wrapDb(() =>
		db.agentThread.findFirst({where: {id: threadId, orgId}, select: threadSelect}),
	);
}

/** The thread a job is for, by the job; `Ok(null)` when it is gone. */
export async function getJobThread(threadId: string): Promise<Result<ThreadRow | null, ApiError>> {
	return wrapDb(() => db.agentThread.findUnique({where: {id: threadId}, select: threadSelect}));
}

/** The thread's log, in order. */
export async function listEntries(threadId: string): Promise<Result<EntryRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentEntry.findMany({where: {threadId}, select: entrySelect, orderBy: {seq: 'asc'}}),
		)
	).map((entries) => entries.map(toEntry));
}

/** Whether the agent is busy on the thread: a job of it queued or running, a sleep among them. */
export async function isThreadBusy(threadId: string): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() => db.agentJob.count({where: {threadId, status: {in: ['queued', 'running']}}}))
	).map((count) => count > 0);
}

/** The jobs still to run or running on the thread: what the agent is up to, for the person. */
export async function listOpenJobs(threadId: string): Promise<Result<JobRow[], ApiError>> {
	return wrapDb(() =>
		db.agentJob.findMany({
			where: {threadId, status: {in: ['queued', 'running']}},
			select: jobSelect,
			orderBy: {runAt: 'asc'},
		}),
	);
}

/** A new task for the thread's calls, once the one before was abandoned. */
export async function setThreadTask(
	threadId: string,
	taskId: string,
): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.agentThread.update({where: {id: threadId}, data: {taskId}}))).map(
		() => undefined,
	);
}

// Locks the thread's row for the rest of the transaction; false when there is no such thread.
async function lockThread(tx: Tx, threadId: string): Promise<boolean> {
	const rows = await tx.$queryRaw<
		Array<{id: string}>
	>`SELECT "id" FROM "AgentThread" WHERE "id" = ${threadId} FOR UPDATE`;
	return rows.length > 0;
}

// Queues an inference job for the thread unless one is queued or running already. With the
// thread locked.
async function queueInference(tx: Tx, threadId: string): Promise<void> {
	const active = await tx.agentJob.count({
		where: {threadId, kind: 'inference', status: {in: ['queued', 'running']}},
	});
	if (active > 0) {
		return;
	}
	await tx.agentJob.create({data: {threadId, kind: 'inference'}});
}

/** Appends what the person said and wakes the agent. `Ok(null)` means no such thread. */
export async function appendPersonMessage(
	threadId: string,
	text: string,
): Promise<Result<EntryRow | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (!(await lockThread(tx, threadId))) {
				return null;
			}
			const entry = await tx.agentEntry.create({
				data: {threadId, kind: 'person' satisfies AgentEntryKind, text},
				select: entrySelect,
			});
			await queueInference(tx, threadId);
			return toEntry(entry);
		}),
	);
}

/**
 * Claims the next job due for `workerId`: one queued whose time has come, or one running whose
 * worker's lease ran out, the earliest due first. `Ok(null)` when none is due. The claim holds for
 * `leaseMs`, and `renewLease` keeps it.
 */
export async function claimJob(
	workerId: string,
	leaseMs: number,
): Promise<Result<JobRow | null, ApiError>> {
	return (
		await wrapDb(
			() =>
				db.$queryRaw<Array<JobRow>>`
				UPDATE "AgentJob" SET
					"status" = 'running',
					"claimedBy" = ${workerId},
					"leaseExpiresAt" = now() + make_interval(secs => ${leaseMs / 1000}),
					"attempts" = "attempts" + 1,
					"updatedAt" = now()
				WHERE "id" = (
					SELECT "id" FROM "AgentJob"
					WHERE ("status" = 'queued' AND "runAt" <= now())
						OR ("status" = 'running' AND "leaseExpiresAt" < now())
					ORDER BY "runAt" ASC
					LIMIT 1
					FOR UPDATE SKIP LOCKED
				)
				RETURNING "id", "threadId", "kind", "status", "entryId", "callId", "runAt", "claimedBy", "attempts"`,
		)
	).map((rows) => rows[0] ?? null);
}

/** Keeps the worker's claim on the job; `Ok(false)` when the job is no longer its. */
export async function renewLease(
	jobId: string,
	workerId: string,
	leaseMs: number,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(
			() => db.$executeRaw`
				UPDATE "AgentJob" SET "leaseExpiresAt" = now() + make_interval(secs => ${leaseMs / 1000}), "updatedAt" = now()
				WHERE "id" = ${jobId} AND "claimedBy" = ${workerId} AND "status" = 'running'`,
		)
	).map((count) => count > 0);
}

// Marks the worker's running job as `status`; false when the job is no longer the worker's, in
// which case nothing else of the transaction should go through.
async function fence(
	tx: Tx,
	jobId: string,
	workerId: string,
	status: AgentJobStatus,
	error: string | null = null,
): Promise<boolean> {
	const {count} = await tx.agentJob.updateMany({
		where: {id: jobId, claimedBy: workerId, status: 'running'},
		data: {status, error, claimedBy: null, leaseExpiresAt: null},
	});
	return count > 0;
}

// Whether the job is still the worker's to write for. With the thread locked.
async function held(tx: Tx, jobId: string, workerId: string): Promise<boolean> {
	const count = await tx.agentJob.count({
		where: {id: jobId, claimedBy: workerId, status: 'running'},
	});
	return count > 0;
}

// Gives the job back to the queue, to run at `runAt`; false when it is no longer the worker's.
async function requeue(tx: Tx, jobId: string, workerId: string, runAt: Date): Promise<boolean> {
	const {count} = await tx.agentJob.updateMany({
		where: {id: jobId, claimedBy: workerId, status: 'running'},
		data: {status: 'queued', runAt, claimedBy: null, leaseExpiresAt: null},
	});
	return count > 0;
}

/** Marks the worker's job done with nothing written; `Ok(false)` when it was no longer the worker's. */
export async function finishJob(
	jobId: string,
	workerId: string,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() => db.$transaction((tx) => fence(tx, jobId, workerId, 'done')));
}

/** Marks the worker's job failed, saying why; `Ok(false)` when it was no longer the worker's. */
export async function failJob(
	jobId: string,
	workerId: string,
	error: string,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() => db.$transaction((tx) => fence(tx, jobId, workerId, 'failed', error)));
}

/** Puts the worker's job back in the queue for later; `Ok(false)` when it was no longer the worker's. */
export async function requeueJob(
	jobId: string,
	workerId: string,
	runAt: Date,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() => db.$transaction((tx) => requeue(tx, jobId, workerId, runAt)));
}

/** What the model answered: its text, its tool calls, and what they cost. */
export type AssistantTurn = {
	text: string;
	toolCalls: ToolCall[];
	inputTokens: number;
	outputTokens: number;
};

/**
 * Appends a summary of the log through `coversSeq`, from the inference job that made it on its
 * way to answering; the job goes on. `Ok(false)` when the job was no longer the worker's, and
 * nothing is written.
 */
export async function appendSummary(
	jobId: string,
	workerId: string,
	threadId: string,
	summary: {text: string; inputTokens: number; outputTokens: number},
	coversSeq: number,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockThread(tx, threadId);
			if (!(await held(tx, jobId, workerId))) {
				return false;
			}
			await tx.agentEntry.create({
				data: {
					threadId,
					kind: 'summary' satisfies AgentEntryKind,
					text: summary.text,
					inputTokens: summary.inputTokens,
					outputTokens: summary.outputTokens,
					coversSeq,
				},
				select: {id: true},
			});
			return true;
		}),
	);
}

/**
 * Finishes an inference job with the model's answer: the assistant entry, and a tool job for each
 * of its calls, due at `runAt` where a call says when (a sleep), else now. `Ok(false)` when the
 * job was no longer the worker's, and nothing is written.
 */
export async function completeInference(
	jobId: string,
	workerId: string,
	threadId: string,
	turn: AssistantTurn,
	runAt: Record<string, Date>,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockThread(tx, threadId);
			if (!(await fence(tx, jobId, workerId, 'done'))) {
				return false;
			}
			const entry = await tx.agentEntry.create({
				data: {
					threadId,
					kind: 'assistant' satisfies AgentEntryKind,
					text: turn.text,
					toolCalls: turn.toolCalls.length === 0 ? null : JSON.stringify(turn.toolCalls),
					inputTokens: turn.inputTokens,
					outputTokens: turn.outputTokens,
				},
				select: {id: true},
			});
			if (turn.toolCalls.length > 0) {
				await tx.agentJob.createMany({
					data: turn.toolCalls.map((call) => ({
						threadId,
						kind: 'tool' satisfies AgentJobKind,
						entryId: entry.id,
						callId: call.id,
						runAt: runAt[call.id] ?? new Date(),
					})),
				});
			}
			return true;
		}),
	);
}

/**
 * Finishes a tool job with what the call answered, and wakes the agent once every call of the
 * answer has its result. `Ok(false)` when the job was no longer the worker's, and nothing is
 * written.
 */
export async function completeToolJob(
	jobId: string,
	workerId: string,
	threadId: string,
	result: {callId: string; text: string; isError: boolean},
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockThread(tx, threadId);
			if (!(await fence(tx, jobId, workerId, 'done'))) {
				return false;
			}
			await tx.agentEntry.create({
				data: {
					threadId,
					kind: 'tool_result' satisfies AgentEntryKind,
					text: result.text,
					callId: result.callId,
					isError: result.isError,
				},
			});
			const entries = (
				await tx.agentEntry.findMany({
					where: {threadId},
					select: entrySelect,
					orderBy: {seq: 'asc'},
				})
			).map(toEntry);
			if (pendingToolCalls(entries).length === 0) {
				await queueInference(tx, threadId);
			}
			return true;
		}),
	);
}

/**
 * Finishes an inference job that found nothing to do, with the thread locked, so a result landing
 * meanwhile queues the next one. `Ok(false)` when the job was no longer the worker's.
 */
export async function finishIdleInference(
	jobId: string,
	workerId: string,
	threadId: string,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockThread(tx, threadId);
			return fence(tx, jobId, workerId, 'done');
		}),
	);
}

/** The assistant entry a tool job's call is in; `Err` not found when it is gone. */
export async function getEntry(entryId: string): Promise<Result<EntryRow, ApiError>> {
	const found = await wrapDb(() =>
		db.agentEntry.findUnique({where: {id: entryId}, select: entrySelect}),
	);
	if (found.isErr()) {
		return found;
	}
	if (found.value === null) {
		return Err(ApiErr.notFound('entry', entryId));
	}
	return Ok(toEntry(found.value));
}
