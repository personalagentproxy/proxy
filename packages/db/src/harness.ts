import type {AgentEntryKind, AgentJobKind, AgentJobStatus, Prisma} from '@prisma/client';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';
import {
	type Look,
	type LogEntry,
	parseLook,
	readyForInference,
	type ToolCall,
} from '@proxy/utils/harness';
import {TASK_ABANDONED_AFTER_MS} from '@proxy/utils/tasks';

import {db} from '.';
import {signedInAgentSelect, type SignedInAgent, toSignedInAgent} from './signed-in-agent';

/**
 * The Chat page: the organization's personas, each with a thread per member, the member's
 * conversation with it, and a thread per sub-agent started from it, each with its log and its
 * jobs. Every persona acts through the organization's one built-in agent login, whose grants and
 * activity log are every persona's. Every change to a thread's log or its jobs is made with the thread's row locked, so a
 * result landing and the model being run on the log never race: either the inference job sees
 * the result, or the result sees no job and queues one. A worker's write is fenced by its lease:
 * it goes through only while the job is still its. A sub-agent's thread ends with its report,
 * which lands in the thread it was started from as the answer to the call that started it; a
 * sub-agent's thread is locked before its parent's, never the other way, so two can't wait on
 * each other.
 */

export type ThreadRow = {
	id: string;
	orgId: string;
	// The organization's built-in agent login, which the persona acts through.
	agentId: string;
	// The persona the conversation is with, or the sub-agent works as.
	personaId: string;
	// The member whose conversation it is, or was started from.
	userId: string;
	// A sub-agent's thread: the thread it was delegated from, and the call that started it.
	parentThreadId: string | null;
	parentCallId: string | null;
	// A sub-agent's title; null for a conversation.
	title: string | null;
	// A sub-agent's task; null for a conversation, whose agent makes no calls but to delegate.
	taskId: string | null;
	// When a sub-agent reported, or failed; null while it works, and for a conversation.
	finishedAt: Date | null;
	createdAt: Date;
};

/** What a persona is: its name and its head, a look and a color. */
export type Persona = {name: string; look: Look; color: string};

/** A persona as the Chat page lists it, with who made it, who may change it beside the organization's owner. */
export type PersonaRow = Persona & {id: string; createdById: string | null};

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

/** What is to happen with a call the model made: when its job may run, and, for a delegation, what it is answered at once with, since the report comes later as an event. */
export type CallPlan = {runAt: Date; placeholder: string | null};

// How much of a sub-agent's report its task keeps as the outcome, and of its brief as the goal.
const MAX_TASK_TEXT = 2000;

const threadSelect = {
	id: true,
	orgId: true,
	agentId: true,
	personaId: true,
	userId: true,
	parentThreadId: true,
	parentCallId: true,
	title: true,
	taskId: true,
	finishedAt: true,
	createdAt: true,
} as const;

const personaSelect = {
	id: true,
	name: true,
	look: true,
	color: true,
	createdById: true,
} as const;

function toPersona(persona: {
	id: string;
	name: string;
	look: string;
	color: string;
	createdById: string | null;
}): PersonaRow {
	return {...persona, look: parseLook(persona.look)};
}

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

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The organization's personas, oldest first, with the last thing said in the member's conversation with each. */
export async function listPersonas(
	orgId: string,
	userId: string,
): Promise<Result<Array<PersonaRow & {lastMessage: LastMessage | null}>, ApiError>> {
	return (
		await wrapDb(() =>
			db.persona.findMany({
				where: {orgId},
				select: {
					...personaSelect,
					threads: {
						where: {userId, parentThreadId: null},
						select: {
							// The agent's turns that only made calls say nothing, so the last with words.
							entries: {
								where: {kind: {in: ['person', 'assistant']}, text: {not: ''}},
								orderBy: {seq: 'desc'},
								take: 1,
								select: {kind: true, text: true, createdAt: true},
							},
						},
					},
				},
				orderBy: {createdAt: 'asc'},
			}),
		)
	).map((personas) =>
		personas.map(({threads, ...persona}) => {
			const last = threads[0]?.entries[0];
			return {
				...toPersona(persona),
				lastMessage:
					last && (last.kind === 'person' || last.kind === 'assistant')
						? {kind: last.kind, text: last.text, createdAt: last.createdAt}
						: null,
			};
		}),
	);
}

/** Personas by id, those of the organization among `ids`, for what names them. */
export async function listPersonasById(
	orgId: string,
	ids: string[],
): Promise<Result<PersonaRow[], ApiError>> {
	if (ids.length === 0) {
		return Ok([]);
	}
	return (
		await wrapDb(() => db.persona.findMany({where: {orgId, id: {in: ids}}, select: personaSelect}))
	).map((personas) => personas.map(toPersona));
}

/** One of the organization's personas; `Ok(null)` for none. */
export async function getPersona(
	orgId: string,
	personaId: string,
): Promise<Result<PersonaRow | null, ApiError>> {
	return (
		await wrapDb(() => db.persona.findFirst({where: {id: personaId, orgId}, select: personaSelect}))
	).map((persona) => (persona ? toPersona(persona) : null));
}

/** A new persona of the organization, made by the member. */
export async function createPersona(
	orgId: string,
	createdById: string,
	persona: Persona,
): Promise<Result<PersonaRow, ApiError>> {
	return (
		await wrapDb(() =>
			db.persona.create({
				data: {
					orgId,
					createdById,
					name: persona.name,
					look: JSON.stringify(persona.look),
					color: persona.color,
				},
				select: personaSelect,
			}),
		)
	).map(toPersona);
}

/** Renames a persona or changes its head; `Ok(false)` means no such persona in the organization. */
export async function updatePersona(
	orgId: string,
	personaId: string,
	persona: Persona,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.persona.updateMany({
				where: {id: personaId, orgId},
				data: {name: persona.name, look: JSON.stringify(persona.look), color: persona.color},
			}),
		)
	).map(({count}) => count > 0);
}

/** Deletes a persona with every member's conversation with it; `Ok(false)` means no such persona in the organization. */
export async function deletePersona(
	orgId: string,
	personaId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.persona.deleteMany({where: {id: personaId, orgId}}))).map(
		({count}) => count > 0,
	);
}

/** The member's conversation with the persona; `Ok(null)` before they have one. */
export async function getMemberThread(
	personaId: string,
	userId: string,
): Promise<Result<ThreadRow | null, ApiError>> {
	return wrapDb(() =>
		db.agentThread.findFirst({
			where: {personaId, userId, parentThreadId: null},
			select: threadSelect,
		}),
	);
}

/**
 * The member's conversation with the persona, made where they have none yet, through the
 * organization's built-in login `agentId`: the one there is otherwise, two first openings at once
 * making one, since the persona's row is locked meanwhile.
 */
export async function ensureMemberThread(data: {
	orgId: string;
	agentId: string;
	personaId: string;
	userId: string;
}): Promise<Result<ThreadRow, ApiError>> {
	const {personaId, userId} = data;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT "id" FROM "Persona" WHERE "id" = ${personaId} FOR UPDATE`;
			const existing = await tx.agentThread.findFirst({
				where: {personaId, userId, parentThreadId: null},
				select: threadSelect,
			});
			if (existing) {
				return existing;
			}
			return tx.agentThread.create({data, select: threadSelect});
		}),
	);
}

/** The last thing said in a thread, by the person or the agent. */
export type LastMessage = {kind: 'person' | 'assistant'; text: string; createdAt: Date};

/**
 * The thread's agent as it acts in the thread: signed in as the member whose conversation it is,
 * so it reaches what they see, their own connections and vault beside the shared ones. `Ok(null)`
 * when the agent is gone or revoked.
 */
export async function getThreadAgent(
	thread: ThreadRow,
): Promise<Result<SignedInAgent | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.agent.findUnique({where: {id: thread.agentId}, select: signedInAgentSelect}),
		)
	).map((agent) => {
		const signedIn = agent ? toSignedInAgent(agent) : null;
		return signedIn ? {...signedIn, ownerUserId: thread.userId} : null;
	});
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

/**
 * The jobs still to run or running on the thread, and on the sub-agents started from it that
 * aren't done: what the agent is up to, for the person.
 */
export async function listOpenJobs(threadId: string): Promise<Result<JobRow[], ApiError>> {
	return wrapDb(() =>
		db.agentJob.findMany({
			where: {
				status: {in: ['queued', 'running']},
				OR: [{threadId}, {thread: {parentThreadId: threadId, finishedAt: null}}],
			},
			select: jobSelect,
			orderBy: {runAt: 'asc'},
		}),
	);
}

/** A new task for a sub-agent's calls, once the one before was abandoned. */
export async function setThreadTask(
	threadId: string,
	taskId: string,
): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.agentThread.update({where: {id: threadId}, data: {taskId}}))).map(
		() => undefined,
	);
}

// Locks the thread's row for the rest of the transaction, and gives the thread as it is; null
// when there is no such thread.
async function lockThread(tx: Tx, threadId: string): Promise<ThreadRow | null> {
	const rows = await tx.$queryRaw<
		Array<{id: string}>
	>`SELECT "id" FROM "AgentThread" WHERE "id" = ${threadId} FOR UPDATE`;
	if (rows.length === 0) {
		return null;
	}
	return tx.agentThread.findUnique({where: {id: threadId}, select: threadSelect});
}

// Queues an inference job for the thread unless one is queued or running already, or the thread
// is done. With the thread locked.
async function queueInference(tx: Tx, thread: ThreadRow): Promise<void> {
	if (thread.finishedAt !== null) {
		return;
	}
	const active = await tx.agentJob.count({
		where: {threadId: thread.id, kind: 'inference', status: {in: ['queued', 'running']}},
	});
	if (active > 0) {
		return;
	}
	await tx.agentJob.create({data: {threadId: thread.id, kind: 'inference'}});
}

// Queues an inference job where the log is ready for one. With the thread locked.
async function wakeIfReady(tx: Tx, thread: ThreadRow): Promise<void> {
	const entries = (
		await tx.agentEntry.findMany({
			where: {threadId: thread.id},
			select: entrySelect,
			orderBy: {seq: 'asc'},
		})
	).map(toEntry);
	if (readyForInference(entries)) {
		await queueInference(tx, thread);
	}
}

// Answers a call of the thread's log, as its result or, for one answered at once as started, as
// an event, and wakes the agent where the log is then ready. With the thread locked.
async function answerCall(
	tx: Tx,
	thread: ThreadRow,
	kind: 'tool_result' | 'event',
	answer: {callId: string; text: string; isError: boolean},
): Promise<void> {
	await tx.agentEntry.create({
		data: {
			threadId: thread.id,
			kind,
			text: answer.text,
			callId: answer.callId,
			isError: answer.isError,
		},
	});
	await wakeIfReady(tx, thread);
}

// Ends a sub-agent's work with its report: its thread is done, its task finished with the report
// as the outcome (unless abandoned meanwhile, as a task is a day after its last start), and the
// report answers the call that started it, in the thread it was started from. With the sub-agent's
// thread locked; its parent's is locked here, after.
async function endSubAgent(
	tx: Tx,
	thread: ThreadRow,
	report: {text: string; isError: boolean},
): Promise<void> {
	if (
		thread.finishedAt !== null ||
		thread.parentThreadId === null ||
		thread.parentCallId === null
	) {
		return;
	}
	const now = new Date();
	await tx.agentThread.update({where: {id: thread.id}, data: {finishedAt: now}});
	if (thread.taskId !== null) {
		await tx.agentTask.updateMany({
			where: {
				id: thread.taskId,
				finishedAt: null,
				lastStartedAt: {gt: new Date(now.getTime() - TASK_ABANDONED_AFTER_MS)},
			},
			data: {finishedAt: now, outcome: cut(report.text, MAX_TASK_TEXT)},
		});
	}
	const parent = await lockThread(tx, thread.parentThreadId);
	if (!parent) {
		return;
	}
	await answerCall(tx, parent, 'event', {callId: thread.parentCallId, ...report});
}

/** Appends what the person said and wakes the agent. `Ok(null)` means no such thread. */
export async function appendPersonMessage(
	threadId: string,
	text: string,
): Promise<Result<EntryRow | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, threadId);
			if (!thread) {
				return null;
			}
			const entry = await tx.agentEntry.create({
				data: {threadId, kind: 'person' satisfies AgentEntryKind, text},
				select: entrySelect,
			});
			await queueInference(tx, thread);
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

/** Marks the worker's job done with nothing written; `Ok(false)` when it was no longer the worker's. */
export async function finishJob(
	jobId: string,
	workerId: string,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() => db.$transaction((tx) => fence(tx, jobId, workerId, 'done')));
}

/**
 * Marks the worker's job failed, saying why, and keeps the thread going: a tool job's call is
 * answered with the failure, so the agent isn't left waiting for it, and a sub-agent whose turn
 * failed reports the failure, so neither is whoever delegated to it. `Ok(false)` when the job was
 * no longer the worker's.
 */
export async function failJob(
	jobId: string,
	workerId: string,
	error: string,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const job = await tx.agentJob.findUnique({where: {id: jobId}, select: jobSelect});
			if (!job) {
				return false;
			}
			const thread = await lockThread(tx, job.threadId);
			if (!(await fence(tx, jobId, workerId, 'failed', error))) {
				return false;
			}
			if (!thread) {
				return true;
			}
			if (job.kind === 'tool' && job.callId !== null) {
				await answerCall(tx, thread, 'tool_result', {
					callId: job.callId,
					text: `This call could not be run: ${error}`,
					isError: true,
				});
				return true;
			}
			if (job.kind === 'inference') {
				await endSubAgent(tx, thread, {text: `The sub-agent failed: ${error}`, isError: true});
			}
			return true;
		}),
	);
}

/** Puts the worker's job back in the queue for later; `Ok(false)` when it was no longer the worker's. */
export async function requeueJob(
	jobId: string,
	workerId: string,
	runAt: Date,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const {count} = await tx.agentJob.updateMany({
				where: {id: jobId, claimedBy: workerId, status: 'running'},
				data: {status: 'queued', runAt, claimedBy: null, leaseExpiresAt: null},
			});
			return count > 0;
		}),
	);
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
 * of its calls, due when its plan says; a call with a placeholder in its plan, a delegation, is
 * answered with it at once, and what it comes to lands as an event. A sub-agent's answer with no
 * calls is its report, which ends its work and answers the call that started it. `Ok(false)` when
 * the job was no longer the worker's, and nothing is written.
 */
export async function completeInference(
	jobId: string,
	workerId: string,
	threadId: string,
	turn: AssistantTurn,
	plans: Record<string, CallPlan>,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, threadId);
			if (!thread || !(await fence(tx, jobId, workerId, 'done'))) {
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
			if (turn.toolCalls.length === 0) {
				await endSubAgent(tx, thread, {text: turn.text, isError: false});
				return true;
			}
			await tx.agentJob.createMany({
				data: turn.toolCalls.map((call) => ({
					threadId,
					kind: 'tool' satisfies AgentJobKind,
					entryId: entry.id,
					callId: call.id,
					runAt: plans[call.id]?.runAt ?? new Date(),
				})),
			});
			const started: Prisma.AgentEntryCreateManyInput[] = turn.toolCalls.flatMap((call) => {
				const placeholder = plans[call.id]?.placeholder;
				if (placeholder === null || placeholder === undefined) {
					return [];
				}
				return [{threadId, kind: 'tool_result', text: placeholder, callId: call.id}];
			});
			if (started.length > 0) {
				await tx.agentEntry.createMany({data: started});
				await wakeIfReady(tx, thread);
			}
			return true;
		}),
	);
}

/**
 * Finishes a tool job with what the call answered, and wakes the agent once the log is ready:
 * every call of its last answer has its result. `Ok(false)` when the job was no longer the
 * worker's, and nothing is written.
 */
export async function completeToolJob(
	jobId: string,
	workerId: string,
	threadId: string,
	result: {callId: string; text: string; isError: boolean},
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, threadId);
			if (!thread || !(await fence(tx, jobId, workerId, 'done'))) {
				return false;
			}
			await answerCall(tx, thread, 'tool_result', result);
			return true;
		}),
	);
}

/**
 * Finishes a delegate call's tool job by starting the sub-agent: its task, run as the persona, its
 * thread with the brief as the first thing said in it, and its first turn queued. The call was answered as the
 * turn was written; the report lands as an event. `Ok(false)` when the job was no longer the
 * worker's, and nothing is made.
 */
export async function startSubAgent(
	jobId: string,
	workerId: string,
	parent: ThreadRow,
	call: {id: string; title: string; brief: string},
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockThread(tx, parent.id);
			if (!(await fence(tx, jobId, workerId, 'done'))) {
				return false;
			}
			const now = new Date();
			const task = await tx.agentTask.create({
				data: {
					orgId: parent.orgId,
					agentId: parent.agentId,
					ownerUserId: parent.userId,
					personaId: parent.personaId,
					parentId: null,
					title: call.title,
					goal: cut(call.brief, MAX_TASK_TEXT),
					via: 'harness',
					createdAt: now,
					lastStartedAt: now,
				},
				select: {id: true},
			});
			const thread = await tx.agentThread.create({
				data: {
					orgId: parent.orgId,
					agentId: parent.agentId,
					personaId: parent.personaId,
					userId: parent.userId,
					parentThreadId: parent.id,
					parentCallId: call.id,
					title: call.title,
					taskId: task.id,
				},
				select: {id: true},
			});
			await tx.agentEntry.create({
				data: {threadId: thread.id, kind: 'person' satisfies AgentEntryKind, text: call.brief},
			});
			await tx.agentJob.create({data: {threadId: thread.id, kind: 'inference'}});
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
