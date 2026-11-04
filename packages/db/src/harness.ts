import type {
	AgentEntryKind,
	AgentJobEventKind,
	AgentJobKind,
	AgentJobStatus,
	Prisma,
} from '@prisma/client';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';
import {
	DEFAULT_LOOK,
	type Look,
	type LogEntry,
	parseLook,
	pendingToolCalls,
	type ThreadState,
	threadState,
	type ToolCall,
} from '@proxy/utils/harness';

import {db} from '.';
import {signedInAgentSelect, type SignedInAgent, toSignedInAgent} from './signed-in-agent';
import type {NewAgentTask} from './task';

/**
 * The Chat page: the organization's personas, each with a thread per member, the member's
 * conversation with it, and a thread per sub-agent started from it, each with its log and its
 * jobs. Every persona acts through the organization's one built-in agent login, whose grants and
 * activity log are every persona's. Every change to a thread's log or its jobs is made with the
 * thread's row locked. The model is run on a log only once it is ready, and nothing lands in
 * the log while it runs, or while a call it made is still open: what comes meanwhile, the person
 * speaking or a sub-agent's message, is pending until the job ends and every call has its result,
 * then takes its place after them, and wakes the agent again.
 * A worker's write is fenced by its lease: it goes through only while the job is still its.
 * What a sub-agent says to the agent that started it lands in that agent's thread as an event
 * answering the call that started the sub-agent; a sub-agent's thread stops when it answers with
 * no calls, keeping its log, and a message from its parent takes it up again. A conversation and
 * its sub-agents' threads are one lock, the conversation's row: whatever a transaction writes in
 * any of them, it locks that row first, so a message between two of them is written with the
 * answer that sent it, and no two transactions wait on each other. What is written, and when the
 * agent is woken, is the api's to say (its harness): these transactions take it composed.
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
	// A sub-agent's thread: the thread it was started from, and the call that started it.
	parentThreadId: string | null;
	parentCallId: string | null;
	// A sub-agent's title; null for a conversation.
	title: string | null;
	// A sub-agent's task; null for a conversation, whose agent makes no calls but to its sub-agents.
	taskId: string | null;
	createdAt: Date;
};

/** A sub-agent as the agent that started it is told of it: its thread, and what it is up to. */
export type SubAgentRow = ThreadRow & {state: ThreadState};

/** What a persona is: its name and its head, a look and a color. */
export type Persona = {name: string; look: Look; color: string};

/** A persona as the Chat page lists it, with who made it, who may change it beside the organization's owner. */
export type PersonaRow = Persona & {id: string; createdById: string | null};

export type EntryRow = LogEntry & {
	id: string;
	seq: number;
	threadId: string;
	// Landed while the model was answering: not in the log until the answer is.
	pending: boolean;
	isError: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	// A summary entry's reach: the seq of the last entry it stands for.
	coversSeq: number | null;
	// An assistant entry's system prompt, as the model was sent it; null where it wasn't run.
	system: string | null;
	// The job that wrote the entry; null for what the person wrote.
	jobId: string | null;
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

/** What happened to a job: claimed by a worker, put back to be tried again (why in `error`), done, or failed (why in `error`). */
export type JobEventRow = {
	id: string;
	jobId: string;
	threadId: string;
	kind: AgentJobEventKind;
	workerId: string | null;
	error: string | null;
	at: Date;
};

/**
 * What is to happen with a call the model made, as the api composed it: a tool job, due at
 * `runAt`; an answer at once, where the call was no good; a sub-agent started, answered at once
 * with its id, which only this layer knows, so the answer is asked of the id; a message to one of
 * the thread's sub-agents, answered at once with what the sub-agent was up to, or that there is no
 * such sub-agent, which only this layer knows too; or a message to the agent the thread's
 * sub-agent works for, answered at once as sent. The last three are done with the answer written,
 * since they need no worker, and the conversation is locked already.
 */
export type CallPlan =
	| {kind: 'job'; runAt: Date}
	| {kind: 'answer'; text: string; isError: boolean}
	| {kind: 'create_subagent'; start: SubAgentStart; started: (id: string) => string}
	| {
			kind: 'send_to_subagent';
			subAgentId: string;
			entry: NewEntry;
			sent: (subAgent: SubAgentRow | null) => {text: string; isError: boolean};
	  }
	| {kind: 'send_to_parent'; message: {text: string; isError: boolean}; sent: string};

/**
 * Whether the log, from the model's last answer on and without what is pending, is ready for the
 * model: where it is, the thread is given an inference job, unless it has one or is done.
 */
export type Wakes = (tail: LogEntry[]) => boolean;

/** An entry to land in a thread. */
export type NewEntry = {kind: AgentEntryKind; text: string};

/**
 * A sub-agent's answer without calls, which goes to the thread it was started from as an event
 * answering the call that started it: as `stopped` says it, where it stops for now, its task
 * finished with `outcome` and its thread kept for a message to take up; or as `goingOn` says it,
 * where a message came while it answered, which it goes on to read.
 */
export type SubAgentStop = {
	outcome: string;
	stopped: {text: string; isError: boolean};
	goingOn: {text: string; isError: boolean};
};

/** A sub-agent as a call starts it: the call it answers, its thread's title, its task and the first entries of its log. */
export type SubAgentStart = {
	callId: string;
	title: string;
	task: NewAgentTask & {parentId: null};
	/** The first entries of its log, which wake it: at least one, so it is run at all. */
	entries: [NewEntry, ...NewEntry[]];
};

/** What follows the model's answer: each of its calls as planned, or, a sub-agent's answer without calls, its stop. */
export type AfterAnswer = {plans: Record<string, CallPlan>} | {stop: SubAgentStop};

/**
 * What a failed job writes in its thread, so nobody is left waiting on it: an answer to its call,
 * as the call's result; the sub-agent's stop; or the agent's answer, as an error.
 */
export type FailureNote =
	| {kind: 'answer'; callId: string; text: string}
	| {kind: 'stop'; stop: SubAgentStop}
	| {kind: 'reply'; text: string};

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
	createdAt: true,
} as const;

// A thread's jobs still to run or running, as much of them as says what its agent is up to.
const openJobsSelect = {
	where: {status: {in: ['queued', 'running']}},
	select: {kind: true, runAt: true},
} satisfies Prisma.AgentThread$jobsArgs;

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
	pending: true,
	text: true,
	toolCalls: true,
	callId: true,
	isError: true,
	inputTokens: true,
	outputTokens: true,
	coversSeq: true,
	system: true,
	jobId: true,
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

const jobEventSelect = {
	id: true,
	jobId: true,
	threadId: true,
	kind: true,
	workerId: true,
	error: true,
	at: true,
} as const;

type EntryRecord = Prisma.AgentEntryGetPayload<{select: typeof entrySelect}>;

type Tx = Prisma.TransactionClient;

function toEntry(entry: EntryRecord): EntryRow {
	return {
		...entry,
		toolCalls: entry.toolCalls === null ? null : (JSON.parse(entry.toolCalls) as ToolCall[]),
	};
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

/**
 * The organization's first persona, General, made by nobody in particular where it has none: the
 * organization's row is locked meanwhile, so two first openings of Chat make one. The one there
 * is otherwise, which is the oldest.
 */
export async function ensureFirstPersona(orgId: string): Promise<Result<PersonaRow, ApiError>> {
	return (
		await wrapDb(() =>
			db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${orgId} FOR UPDATE`;
				const existing = await tx.persona.findFirst({
					where: {orgId},
					select: personaSelect,
					orderBy: {createdAt: 'asc'},
				});
				if (existing) {
					return existing;
				}
				return tx.persona.create({
					data: {
						orgId,
						createdById: null,
						name: 'General',
						look: JSON.stringify(DEFAULT_LOOK),
						color: 'blue',
					},
					select: personaSelect,
				});
			}),
		)
	).map(toPersona);
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

/** The thread's log, in order: what the model reads, without what is pending. */
export async function listEntries(threadId: string): Promise<Result<EntryRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentEntry.findMany({
				where: {threadId, pending: false},
				select: entrySelect,
				orderBy: {seq: 'asc'},
			}),
		)
	).map((entries) => entries.map(toEntry));
}

/**
 * The thread's turns as the person sees them, what they said and what the persona answered in
 * words, not the calls, their results, the reports or the summaries: the log's, then what is
 * pending, each in order.
 */
export async function listShownEntries(threadId: string): Promise<Result<EntryRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentEntry.findMany({
				where: {threadId, OR: [{kind: 'person'}, {kind: 'assistant', text: {not: ''}}]},
				select: entrySelect,
				orderBy: [{pending: 'asc'}, {seq: 'asc'}],
			}),
		)
	).map((entries) => entries.map(toEntry));
}

/**
 * The jobs still to run or running on the thread, and on the sub-agents started from it: what
 * the agent is up to, for the person.
 */
export async function listOpenJobs(threadId: string): Promise<Result<JobRow[], ApiError>> {
	return wrapDb(() =>
		db.agentJob.findMany({
			where: {
				status: {in: ['queued', 'running']},
				OR: [{threadId}, {thread: {parentThreadId: threadId}}],
			},
			select: jobSelect,
			orderBy: {runAt: 'asc'},
		}),
	);
}

/** The sub-agents started from the thread, oldest first, each with what it is up to now. */
export async function listSubAgents(
	parentThreadId: string,
	now = new Date(),
): Promise<Result<SubAgentRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentThread.findMany({
				where: {parentThreadId},
				select: {...threadSelect, jobs: openJobsSelect},
				orderBy: {createdAt: 'asc'},
			}),
		)
	).map((threads) =>
		threads.map(({jobs, ...thread}) => ({...thread, state: threadState(jobs, now)})),
	);
}

/** What happened to the thread's jobs, in order: every claim, requeue, finish and failure. */
export async function listJobEvents(threadId: string): Promise<Result<JobEventRow[], ApiError>> {
	return wrapDb(() =>
		db.agentJobEvent.findMany({
			where: {threadId},
			select: jobEventSelect,
			orderBy: {at: 'asc'},
		}),
	);
}

/** A new task for a sub-agent's calls, once the one before was finished while it was at work. */
export async function setThreadTask(
	threadId: string,
	taskId: string,
): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.agentThread.update({where: {id: threadId}, data: {taskId}}))).map(
		() => undefined,
	);
}

// Locks the conversation the thread is part of, its own row or, a sub-agent's, the row of the
// thread it was started from, for the rest of the transaction, and gives the thread as it is;
// null when there is no such thread.
async function lockThread(tx: Tx, threadId: string): Promise<ThreadRow | null> {
	const rows = await tx.$queryRaw<Array<{id: string}>>`
		SELECT "id" FROM "AgentThread"
		WHERE "id" = (SELECT COALESCE("parentThreadId", "id") FROM "AgentThread" WHERE "id" = ${threadId})
		FOR UPDATE`;
	if (rows.length === 0) {
		return null;
	}
	return tx.agentThread.findUnique({where: {id: threadId}, select: threadSelect});
}

// Queues an inference job for the thread unless one is queued or running already. With the
// thread locked.
async function queueInference(tx: Tx, thread: ThreadRow): Promise<void> {
	const active = await tx.agentJob.count({
		where: {threadId: thread.id, kind: 'inference', status: {in: ['queued', 'running']}},
	});
	if (active > 0) {
		return;
	}
	await tx.agentJob.create({data: {threadId: thread.id, kind: 'inference'}});
}

// The log from the model's last answer on, without what is pending: whether the log is ready for
// the model, and whether its calls are answered, show in that much. With the thread locked.
async function tailOf(tx: Tx, thread: ThreadRow): Promise<EntryRow[]> {
	const lastAnswer = await tx.agentEntry.findFirst({
		where: {threadId: thread.id, pending: false, kind: 'assistant'},
		select: {seq: true},
		orderBy: {seq: 'desc'},
	});
	return (
		await tx.agentEntry.findMany({
			where: {threadId: thread.id, pending: false, seq: {gte: lastAnswer?.seq ?? 0}},
			select: entrySelect,
			orderBy: {seq: 'asc'},
		})
	).map(toEntry);
}

// Whether what lands now has to wait: an inference job runs on the thread, whose answer comes
// first, or the model's last answer has calls without their results yet, which have to follow it
// directly, as the model reads them; anything between them and it is refused. With the thread
// locked.
async function holding(tx: Tx, thread: ThreadRow): Promise<boolean> {
	const running = await tx.agentJob.count({
		where: {threadId: thread.id, kind: 'inference', status: 'running'},
	});
	if (running > 0) {
		return true;
	}
	return pendingToolCalls(await tailOf(tx, thread)).length > 0;
}

// Gives the thread's pending entries their place in the log, in the order they landed, once
// nothing holds them any more: after what the inference job that just ended wrote, or after the
// result of the last call still open; and queues an inference job where the log then `wakes` the
// agent. With the thread locked.
async function release(tx: Tx, thread: ThreadRow, wakes: Wakes): Promise<void> {
	if (await holding(tx, thread)) {
		return;
	}
	const pending = await tx.agentEntry.findMany({
		where: {threadId: thread.id, pending: true},
		select: {id: true},
		orderBy: {seq: 'asc'},
	});
	for (const {id} of pending) {
		await tx.$executeRaw`UPDATE "AgentEntry" SET "seq" = nextval(pg_get_serial_sequence('"AgentEntry"', 'seq')), "pending" = false WHERE "id" = ${id}`;
	}
	if (wakes(await tailOf(tx, thread))) {
		await queueInference(tx, thread);
	}
}

// Lands an entry in the thread: a call's result in the log, directly after the answer that made
// the call; anything else in the log too where nothing holds it, or pending until what holds it
// ends (`release`). What lands in the log releases what was pending where it can, and wakes the
// agent where the log then `wakes` it. With the thread locked.
async function appendEntry(
	tx: Tx,
	thread: ThreadRow,
	data: NewEntry & {callId?: string; isError?: boolean; jobId?: string},
	wakes: Wakes,
): Promise<EntryRow> {
	const pending = data.kind !== 'tool_result' && (await holding(tx, thread));
	const entry = await tx.agentEntry.create({
		data: {threadId: thread.id, ...data, pending},
		select: entrySelect,
	});
	if (!pending) {
		await release(tx, thread, wakes);
	}
	return toEntry(entry);
}

// Answers a call of the thread's log, as its result or, for one answered at once as started, as
// an event, from the job that has the answer. With the thread locked.
async function answerCall(
	tx: Tx,
	thread: ThreadRow,
	kind: 'tool_result' | 'event',
	answer: {callId: string; text: string; isError: boolean},
	jobId: string,
	wakes: Wakes,
): Promise<void> {
	await appendEntry(tx, thread, {kind, ...answer, jobId}, wakes);
}

// Lands what a sub-agent said in the thread it was started from, as an event answering the call
// that started it, from the sub-agent's job that said it. With the conversation locked.
async function tellParent(
	tx: Tx,
	thread: ThreadRow,
	message: {text: string; isError: boolean},
	jobId: string,
	wakes: Wakes,
): Promise<void> {
	if (thread.parentThreadId === null || thread.parentCallId === null) {
		return;
	}
	const parent = await tx.agentThread.findUnique({
		where: {id: thread.parentThreadId},
		select: threadSelect,
	});
	if (!parent) {
		return;
	}
	await answerCall(tx, parent, 'event', {callId: thread.parentCallId, ...message}, jobId, wakes);
}

// A sub-agent's answer without calls: where a message came while it answered, pending, it goes on
// to read it, its task still under way, and what it said goes to the agent it works for as said
// going on; otherwise its work stops for now, its task finished with the outcome, and what it
// said goes to the agent as said stopping. Its thread stays, log and all, for a message to take
// up again (messageSubAgent). With the conversation locked; what is pending is released after, as
// a job ends (endJob).
async function endTurn(
	tx: Tx,
	thread: ThreadRow,
	stop: SubAgentStop,
	jobId: string,
	wakes: Wakes,
): Promise<void> {
	if (thread.parentThreadId === null) {
		return;
	}
	const waiting = await tx.agentEntry.count({where: {threadId: thread.id, pending: true}});
	if (waiting > 0) {
		await tellParent(tx, thread, stop.goingOn, jobId, wakes);
		return;
	}
	if (thread.taskId !== null) {
		const now = new Date();
		await tx.agentTask.updateMany({
			where: {id: thread.taskId, finishedAt: null},
			data: {finishedAt: now, lastActiveAt: now, outcome: stop.outcome},
		});
	}
	await tellParent(tx, thread, stop.stopped, jobId, wakes);
}

/** Lands what the person said, and wakes the agent where the log `wakes` it. `Ok(null)` means no such thread. */
export async function appendPersonMessage(
	threadId: string,
	text: string,
	wakes: Wakes,
): Promise<Result<EntryRow | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, threadId);
			if (!thread) {
				return null;
			}
			return appendEntry(tx, thread, {kind: 'person', text}, wakes);
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
	// Prisma writes a DateTime as the UTC wall clock, in a column without a time zone; now() has
	// one, and would be read in the server's, so its UTC wall clock is what is compared and
	// written. The claim is noted as an event in the same transaction.
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const rows = await tx.$queryRaw<Array<JobRow>>`
				UPDATE "AgentJob" SET
					"status" = 'running',
					"claimedBy" = ${workerId},
					"leaseExpiresAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}),
					"attempts" = "attempts" + 1,
					"updatedAt" = now() AT TIME ZONE 'UTC'
				WHERE "id" = (
					SELECT "id" FROM "AgentJob"
					WHERE ("status" = 'queued' AND "runAt" <= now() AT TIME ZONE 'UTC')
						OR ("status" = 'running' AND "leaseExpiresAt" < now() AT TIME ZONE 'UTC')
					ORDER BY "runAt" ASC
					LIMIT 1
					FOR UPDATE SKIP LOCKED
				)
				RETURNING "id", "threadId", "kind", "status", "entryId", "callId", "runAt", "claimedBy", "attempts"`;
			const job = rows[0];
			if (!job) {
				return null;
			}
			await tx.agentJobEvent.create({
				data: {jobId: job.id, threadId: job.threadId, kind: 'claimed', workerId},
			});
			return job;
		}),
	);
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
				UPDATE "AgentJob" SET "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}), "updatedAt" = now() AT TIME ZONE 'UTC'
				WHERE "id" = ${jobId} AND "claimedBy" = ${workerId} AND "status" = 'running'`,
		)
	).map((count) => count > 0);
}

// Marks the worker's running job as `status`, done or failed, and notes it as an event; false when
// the job is no longer the worker's, in which case nothing else of the transaction should go
// through.
async function fence(
	tx: Tx,
	jobId: string,
	workerId: string,
	status: 'done' | 'failed',
	error: string | null = null,
): Promise<boolean> {
	const {count} = await tx.agentJob.updateMany({
		where: {id: jobId, claimedBy: workerId, status: 'running'},
		data: {status, error, claimedBy: null, leaseExpiresAt: null},
	});
	if (count === 0) {
		return false;
	}
	const {threadId} = await tx.agentJob.findUniqueOrThrow({
		where: {id: jobId},
		select: {threadId: true},
	});
	await tx.agentJobEvent.create({data: {jobId, threadId, kind: status, workerId, error}});
	return true;
}

// Ends the worker's job on its thread: locks the conversation, marks the job `status` (fence),
// writes what `write` does in the thread, then gives what was pending its place in the log and
// wakes the agent where the log then `wakes` it (`release`), so that no way a job ends leaves a
// message unread. False when the job is no longer the worker's, and nothing is written.
async function endJob(
	tx: Tx,
	end: {
		jobId: string;
		workerId: string;
		threadId: string;
		status: 'done' | 'failed';
		error?: string;
	},
	wakes: Wakes,
	write: (thread: ThreadRow) => Promise<void>,
): Promise<boolean> {
	const thread = await lockThread(tx, end.threadId);
	if (!(await fence(tx, end.jobId, end.workerId, end.status, end.error ?? null))) {
		return false;
	}
	if (!thread) {
		return true;
	}
	await write(thread);
	await release(tx, thread, wakes);
	return true;
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
 * Marks the worker's job failed, saying why, and writes what `noteFor` says of it, for the job as
 * it was and its thread, locked, so the thread goes on. `Ok(false)` when the job was no longer
 * the worker's, and nothing is written.
 */
export async function failJob(
	jobId: string,
	workerId: string,
	error: string,
	noteFor: (job: JobRow, thread: ThreadRow) => FailureNote | null,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const job = await tx.agentJob.findUnique({where: {id: jobId}, select: jobSelect});
			if (!job) {
				return false;
			}
			const end = {jobId, workerId, threadId: job.threadId, status: 'failed', error} as const;
			return endJob(tx, end, wakes, async (thread) => {
				const note = noteFor(job, thread);
				if (note) {
					await writeNote(tx, thread, note, job.id, wakes);
				}
			});
		}),
	);
}

// Writes what a failed job leaves in its thread. With the conversation locked; what is pending is
// released after (endJob).
async function writeNote(
	tx: Tx,
	thread: ThreadRow,
	note: FailureNote,
	jobId: string,
	wakes: Wakes,
): Promise<void> {
	if (note.kind === 'answer') {
		await answerCall(
			tx,
			thread,
			'tool_result',
			{callId: note.callId, text: note.text, isError: true},
			jobId,
			wakes,
		);
		return;
	}
	// A sub-agent's turn that failed is its answer, said as the failure, so its log is not left
	// ready for the model again, as the conversation's is not by the reply.
	if (note.kind === 'stop') {
		await tx.agentEntry.create({
			data: {
				threadId: thread.id,
				kind: 'assistant' satisfies AgentEntryKind,
				text: note.stop.goingOn.text,
				isError: true,
				jobId,
			},
		});
		await endTurn(tx, thread, note.stop, jobId, wakes);
		return;
	}
	await tx.agentEntry.create({
		data: {
			threadId: thread.id,
			kind: 'assistant' satisfies AgentEntryKind,
			text: note.text,
			isError: true,
			jobId,
		},
	});
}

/**
 * Puts the worker's job back in the queue for later, saying why, and what landed meanwhile in the
 * log, for it to read then; `Ok(false)` when it was no longer the worker's.
 */
export async function requeueJob(
	jobId: string,
	workerId: string,
	threadId: string,
	runAt: Date,
	why: string,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, threadId);
			const {count} = await tx.agentJob.updateMany({
				where: {id: jobId, claimedBy: workerId, status: 'running'},
				data: {status: 'queued', runAt, claimedBy: null, leaseExpiresAt: null},
			});
			if (count === 0) {
				return false;
			}
			await tx.agentJobEvent.create({
				data: {jobId, threadId, kind: 'requeued', workerId, error: why},
			});
			if (thread) {
				await release(tx, thread, wakes);
			}
			return true;
		}),
	);
}

/** What the model answered: its text, its tool calls, what they cost, and the system prompt it was sent; null where it wasn't run for the answer. */
export type AssistantTurn = {
	text: string;
	toolCalls: ToolCall[];
	inputTokens: number;
	outputTokens: number;
	system: string | null;
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
					jobId,
				},
				select: {id: true},
			});
			return true;
		}),
	);
}

// Makes a sub-agent of the thread's agent, as a call of its starts one: its task, its thread, and
// the first entries of its log, which wake it. The thread is new, so nothing else holds it. With
// the conversation locked.
async function createSubAgent(
	tx: Tx,
	parent: ThreadRow,
	start: SubAgentStart,
	wakes: Wakes,
): Promise<string> {
	const now = new Date();
	const task = await tx.agentTask.create({
		data: {...start.task, createdAt: now, lastActiveAt: now},
		select: {id: true},
	});
	const thread = await tx.agentThread.create({
		data: {
			orgId: parent.orgId,
			agentId: parent.agentId,
			personaId: parent.personaId,
			userId: parent.userId,
			parentThreadId: parent.id,
			parentCallId: start.callId,
			title: start.title,
			taskId: task.id,
		},
		select: threadSelect,
	});
	for (const entry of start.entries) {
		await appendEntry(tx, thread, entry, wakes);
	}
	return thread.id;
}

// Lands a message from the agent that started the sub-agent in the sub-agent's log, and wakes the
// sub-agent: one that had stopped takes it up, its task under way again; one at work reads it once
// its current call is answered; and one asleep is woken now, its sleep's job due now, which answers
// the sleep as any wake-up does, the message after it. The sub-agent as it was before the message;
// null when the thread has no such sub-agent. With the conversation locked.
async function messageSubAgent(
	tx: Tx,
	parent: ThreadRow,
	subAgentId: string,
	entry: NewEntry,
	wakes: Wakes,
): Promise<SubAgentRow | null> {
	const found = await tx.agentThread.findFirst({
		where: {id: subAgentId, parentThreadId: parent.id},
		select: {...threadSelect, jobs: openJobsSelect},
	});
	if (!found) {
		return null;
	}
	const {jobs, ...thread} = found;
	const now = new Date();
	if (thread.taskId !== null) {
		await tx.agentTask.updateMany({
			where: {id: thread.taskId},
			data: {finishedAt: null, outcome: null, lastActiveAt: now},
		});
	}
	// Only a sleep's job is due later; one a worker has claimed is no longer queued, and answers as it
	// would.
	await tx.agentJob.updateMany({
		where: {threadId: thread.id, kind: 'tool', status: 'queued', runAt: {gt: now}},
		data: {runAt: now},
	});
	await appendEntry(tx, thread, entry, wakes);
	return {...thread, state: threadState(jobs, now)};
}

// What a call is answered with at once, by its plan, done. With the conversation locked.
async function answerAtOnce(
	tx: Tx,
	thread: ThreadRow,
	plan: Exclude<CallPlan, {kind: 'job'}>,
	jobId: string,
	wakes: Wakes,
): Promise<{text: string; isError: boolean}> {
	if (plan.kind === 'answer') {
		return {text: plan.text, isError: plan.isError};
	}
	if (plan.kind === 'create_subagent') {
		const id = await createSubAgent(tx, thread, plan.start, wakes);
		return {text: plan.started(id), isError: false};
	}
	if (plan.kind === 'send_to_subagent') {
		return plan.sent(await messageSubAgent(tx, thread, plan.subAgentId, plan.entry, wakes));
	}
	await tellParent(tx, thread, plan.message, jobId, wakes);
	return {text: plan.sent, isError: false};
}

/**
 * Finishes an inference job with the model's answer: the assistant entry, then what follows it,
 * each of its calls as its plan says, a tool job due when it says or an answer at once
 * (`CallPlan`); or, a sub-agent's answer without calls, what it said to the agent it works for,
 * and its stop where nothing came meanwhile. A call without a plan gets a tool job due now. What
 * landed meanwhile takes its place in the log after the answer, and wakes the agent where the log
 * then `wakes` it. `Ok(false)` when the job was no longer the worker's, and nothing is written.
 */
export async function completeInference(
	jobId: string,
	workerId: string,
	threadId: string,
	turn: AssistantTurn,
	after: AfterAnswer,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction((tx) =>
			endJob(tx, {jobId, workerId, threadId, status: 'done'}, wakes, async (thread) => {
				const entry = await tx.agentEntry.create({
					data: {
						threadId,
						kind: 'assistant' satisfies AgentEntryKind,
						text: turn.text,
						toolCalls: turn.toolCalls.length === 0 ? null : JSON.stringify(turn.toolCalls),
						inputTokens: turn.inputTokens,
						outputTokens: turn.outputTokens,
						system: turn.system,
						jobId,
					},
					select: {id: true},
				});
				if ('stop' in after) {
					await endTurn(tx, thread, after.stop, jobId, wakes);
					return;
				}
				for (const call of turn.toolCalls) {
					const plan: CallPlan = after.plans[call.id] ?? {kind: 'job', runAt: new Date()};
					if (plan.kind === 'job') {
						await tx.agentJob.create({
							data: {
								threadId,
								kind: 'tool' satisfies AgentJobKind,
								entryId: entry.id,
								callId: call.id,
								runAt: plan.runAt,
							},
						});
						continue;
					}
					const answered = await answerAtOnce(tx, thread, plan, jobId, wakes);
					await tx.agentEntry.create({
						data: {
							threadId,
							kind: 'tool_result' satisfies AgentEntryKind,
							callId: call.id,
							jobId,
							...answered,
						},
					});
				}
			}),
		),
	);
}

/**
 * Finishes a tool job with what the call answered, and wakes the agent where the log then
 * `wakes` it. `Ok(false)` when the job was no longer the worker's, and nothing is written.
 */
export async function completeToolJob(
	jobId: string,
	workerId: string,
	threadId: string,
	result: {callId: string; text: string; isError: boolean},
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction((tx) =>
			endJob(tx, {jobId, workerId, threadId, status: 'done'}, wakes, (thread) =>
				answerCall(tx, thread, 'tool_result', result, jobId, wakes),
			),
		),
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
