import type {
	AgentAlertEnd,
	AgentEntryKind,
	AgentJobEventKind,
	AgentJobKind,
	AgentJobStatus,
	Prisma,
} from '@prisma/client';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';
import type {Criteria, PollItem} from '@proxy/utils/alerts';
import {
	DEFAULT_LOOK,
	type Look,
	type LogEntry,
	parseLook,
	pendingToolCalls,
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
 * speaking or a sub-agent reporting, is pending until the job ends and every call has its result,
 * then takes its place after them, and wakes the agent again.
 * A worker's write is fenced by its lease: it goes through only while the job is still its. A
 * sub-agent's thread ends with its report, which lands in the thread it was started from as the
 * answer to the call that started it; a sub-agent's thread is locked before its parent's, never
 * the other way, so two can't wait on each other. A timed alert the agent set in a conversation
 * is a job due when the alert is, which lands what the alert is due with in the conversation. A
 * watch is a rule on a collection of some connections, each polled while any watch is on it: a
 * poll is claimed with a lease as a job is, and what it finds to match lands in the conversations
 * the watches were set in. A poll's row is locked before a conversation's, and an alert's before
 * a conversation's, never the other way. What is written, and when the agent is woken, is the
 * api's to say (its harness): these transactions take it composed.
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
	// A timed alert's job: the alert.
	alertId: string | null;
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

/** What is to happen with a call the model made: when its job may run, and, for a delegation, what it is answered at once with, since the report comes later as an event. */
export type CallPlan = {runAt: Date; placeholder: string | null};

/** How an alert ended. */
export type AlertEnd = AgentAlertEnd;

/** An alert, as the agent set it: at a time, or a watch on a collection of some connections. */
export type AlertRow = {
	id: string;
	orgId: string;
	agentId: string;
	personaId: string;
	userId: string;
	// The conversation it was set in, where what it comes to lands.
	threadId: string;
	title: string;
	brief: string;
	// A timed alert's time; null for a watch.
	at: Date | null;
	// A watch: the collection, the connections it watches, and its criteria as JSON
	// (@proxy/utils/alerts); null, none and null for a timed alert.
	collectionId: string | null;
	connectionIds: string[];
	criteria: string | null;
	endedAt: Date | null;
	endedBy: AlertEnd | null;
	createdAt: Date;
};

/** An alert to set: at a time, or a watch, its connections resolved to those the agent may watch. */
export type NewAlert = {title: string; brief: string} & (
	| {kind: 'time'; at: Date}
	| {kind: 'watch'; collectionId: string; connectionIds: string[]; criteria: Criteria}
);

/** One collection of one connection, polled while a watch is on it: where the last poll left off, and when the next is due. */
export type PollRow = {
	id: string;
	orgId: string;
	connectionId: string;
	collectionId: string;
	cursor: string | null;
	nextAt: Date;
	claimedBy: string | null;
	lastPolledAt: Date | null;
	lastError: string | null;
};

/** A record a watch matched, as the Alerts page shows it. */
export type MatchRow = {
	id: string;
	alertId: string;
	connectionId: string;
	collectionId: string;
	recordId: string;
	title: string;
	summary: string;
	url: string | null;
	createdAt: Date;
};

/** A record a watch matched, as the poll found it, with what is kept of it. */
export type MatchedItem = PollItem & {summary: string};

/**
 * What a poll came to: where it left off and when the next is due; what it failed with, if it
 * did; and for each watch, the records that matched it, of which those matched before are left
 * out, and what is then told in the watch's conversation, as the api's rules say.
 */
export type PollOutcome = {
	cursor: string | null;
	nextAt: Date;
	error: string | null;
	matches: Array<{alert: AlertRow; items: MatchedItem[]}>;
};

/** What a watch's conversation is told of the records that matched it now. */
export type MatchTell = (alert: AlertRow, items: MatchedItem[]) => string;

/**
 * Whether the log, from the model's last answer on and without what is pending, is ready for the
 * model: where it is, the thread is given an inference job, unless it has one or is done.
 */
export type Wakes = (tail: LogEntry[]) => boolean;

/** An entry to land in a thread. */
export type NewEntry = {kind: AgentEntryKind; text: string};

/** How a sub-agent's work ends: its task's outcome, and its report, which answers the call that started it, in the thread it was started from. */
export type SubAgentEnd = {outcome: string; report: {text: string; isError: boolean}};

/** A sub-agent as a delegation starts it: the call it answers, its thread's title, its task and the first entries of its log. */
export type SubAgentStart = {
	callId: string;
	title: string;
	task: NewAgentTask & {parentId: null};
	/** The first entries of its log, which wake it: at least one, so it is run at all. */
	entries: [NewEntry, ...NewEntry[]];
};

/** What follows the model's answer: a job for each of its calls, as planned, or, a sub-agent's report, the end of its work. */
export type AfterAnswer = {plans: Record<string, CallPlan>} | {end: SubAgentEnd};

/**
 * What a failed job writes in its thread, so nobody is left waiting on it: an answer to its call,
 * as the call's result or, where it was answered as started already, as an event; the end of the
 * sub-agent's work; an event on its own, as a timed alert's job that couldn't run lands; or the
 * agent's answer, as an error.
 */
export type FailureNote =
	| {kind: 'answer'; callId: string; text: string}
	| {kind: 'end'; end: SubAgentEnd}
	| {kind: 'event'; text: string}
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
	alertId: true,
	runAt: true,
	claimedBy: true,
	attempts: true,
} as const;

const alertSelect = {
	id: true,
	orgId: true,
	agentId: true,
	personaId: true,
	userId: true,
	threadId: true,
	title: true,
	brief: true,
	at: true,
	collectionId: true,
	connectionIds: true,
	criteria: true,
	endedAt: true,
	endedBy: true,
	createdAt: true,
} as const;

const pollSelect = {
	id: true,
	orgId: true,
	connectionId: true,
	collectionId: true,
	cursor: true,
	nextAt: true,
	claimedBy: true,
	lastPolledAt: true,
	lastError: true,
} as const;

const matchSelect = {
	id: true,
	alertId: true,
	connectionId: true,
	collectionId: true,
	recordId: true,
	title: true,
	summary: true,
	url: true,
	createdAt: true,
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
 * The jobs still to run or running on the thread, and on the sub-agents started from it that
 * aren't done: what the agent is up to, for the person. Not the alerts set in it, due later: the
 * Alerts page says what is set.
 */
export async function listOpenJobs(threadId: string): Promise<Result<JobRow[], ApiError>> {
	return wrapDb(() =>
		db.agentJob.findMany({
			where: {
				status: {in: ['queued', 'running']},
				kind: {in: ['inference', 'tool']},
				OR: [{threadId}, {thread: {parentThreadId: threadId, finishedAt: null}}],
			},
			select: jobSelect,
			orderBy: {runAt: 'asc'},
		}),
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

// Finishes a sub-agent's thread, and its task with the outcome, taken up again where it was left
// open meanwhile (@proxy/utils/tasks). With the thread locked.
async function finishThread(tx: Tx, thread: ThreadRow, outcome: string, now: Date): Promise<void> {
	await tx.agentThread.update({where: {id: thread.id}, data: {finishedAt: now}});
	if (thread.taskId === null) {
		return;
	}
	await tx.agentTask.updateMany({
		where: {id: thread.taskId, finishedAt: null},
		data: {finishedAt: now, lastActiveAt: now, outcome},
	});
}

// Ends a sub-agent's work: its thread is done, its task finished with the outcome, and the report
// answers the call that started it, in the thread it was started from, from the sub-agent's job
// that ended with it. With the sub-agent's thread locked; its parent's is locked here, after.
async function endSubAgent(
	tx: Tx,
	thread: ThreadRow,
	end: SubAgentEnd,
	jobId: string,
	wakes: Wakes,
): Promise<void> {
	if (
		thread.finishedAt !== null ||
		thread.parentThreadId === null ||
		thread.parentCallId === null
	) {
		return;
	}
	const now = new Date();
	await finishThread(tx, thread, end.outcome, now);
	const parent = await lockThread(tx, thread.parentThreadId);
	if (!parent) {
		return;
	}
	await answerCall(tx, parent, 'event', {callId: thread.parentCallId, ...end.report}, jobId, wakes);
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
				RETURNING "id", "threadId", "kind", "status", "entryId", "callId", "alertId", "runAt", "claimedBy", "attempts"`;
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
 * it was and its thread, locked, so the thread goes on; an alert's job that failed ends the alert,
 * failed with the error. `Ok(false)` when the job was no longer the worker's, and nothing is
 * written.
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
			const thread = await lockThread(tx, job.threadId);
			if (!(await fence(tx, jobId, workerId, 'failed', error))) {
				return false;
			}
			if (job.alertId !== null) {
				await tx.agentAlert.updateMany({
					where: {id: job.alertId, endedAt: null},
					data: {endedAt: new Date(), endedBy: 'failed', lastError: error, nextAt: null},
				});
			}
			const note = thread ? noteFor(job, thread) : null;
			if (!thread || !note) {
				return true;
			}
			await writeNote(tx, thread, note, job.id, wakes);
			return true;
		}),
	);
}

// Writes what a failed job leaves in its thread. With the thread locked.
async function writeNote(
	tx: Tx,
	thread: ThreadRow,
	note: FailureNote,
	jobId: string,
	wakes: Wakes,
): Promise<void> {
	if (note.kind === 'answer') {
		const answered = await tx.agentEntry.count({
			where: {threadId: thread.id, kind: 'tool_result', callId: note.callId},
		});
		const kind = answered > 0 ? 'event' : 'tool_result';
		await answerCall(
			tx,
			thread,
			kind,
			{callId: note.callId, text: note.text, isError: true},
			jobId,
			wakes,
		);
		return;
	}
	if (note.kind === 'end') {
		await endSubAgent(tx, thread, note.end, jobId, wakes);
		return;
	}
	if (note.kind === 'event') {
		await appendEntry(tx, thread, {kind: 'event', text: note.text, isError: true, jobId}, wakes);
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
	await release(tx, thread, wakes);
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

/**
 * Finishes an inference job with the model's answer: the assistant entry, then what follows it,
 * a tool job for each of its calls, due when its plan says, a call with a placeholder in its plan,
 * a delegation, answered with it at once, what it comes to landing as an event; or, a sub-agent's
 * report, the end of its work. What landed meanwhile takes its place in the log after the answer,
 * and wakes the agent where the log then `wakes` it. `Ok(false)` when the job was no longer the
 * worker's, and nothing is written.
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
					system: turn.system,
					jobId,
				},
				select: {id: true},
			});
			if ('end' in after) {
				await endSubAgent(tx, thread, after.end, jobId, wakes);
				return true;
			}
			if (turn.toolCalls.length === 0) {
				await release(tx, thread, wakes);
				return true;
			}
			const {plans} = after;
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
				return [{threadId, kind: 'tool_result', text: placeholder, callId: call.id, jobId}];
			});
			if (started.length > 0) {
				await tx.agentEntry.createMany({data: started});
			}
			await release(tx, thread, wakes);
			return true;
		}),
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
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, threadId);
			if (!thread || !(await fence(tx, jobId, workerId, 'done'))) {
				return false;
			}
			await answerCall(tx, thread, 'tool_result', result, jobId, wakes);
			return true;
		}),
	);
}

/**
 * Finishes a delegate call's tool job by starting the sub-agent: its task, its thread, the
 * parent's agent, persona and member's, under the call it answers, and the first entries of its
 * log, which wake it where they `wake` it. The call was answered as the turn was written; the
 * report lands as an event. `Ok(false)` when the job was no longer the worker's, and nothing is
 * made.
 */
export async function startSubAgent(
	jobId: string,
	workerId: string,
	parent: ThreadRow,
	start: SubAgentStart,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockThread(tx, parent.id);
			if (!(await fence(tx, jobId, workerId, 'done'))) {
				return false;
			}
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
			return true;
		}),
	);
}

// Locks the alert's row for the rest of the transaction, and gives the alert as it is; null when
// there is no such alert.
async function lockAlert(tx: Tx, alertId: string): Promise<AlertRow | null> {
	const rows = await tx.$queryRaw<
		Array<{id: string}>
	>`SELECT "id" FROM "AgentAlert" WHERE "id" = ${alertId} FOR UPDATE`;
	if (rows.length === 0) {
		return null;
	}
	return tx.agentAlert.findUnique({where: {id: alertId}, select: alertSelect});
}

// Lands an event in the conversation, locked here, and wakes the agent where the log then
// `wakes` it; nothing when the conversation is gone.
async function tellConversation(
	tx: Tx,
	threadId: string,
	text: string,
	isError: boolean,
	wakes: Wakes,
): Promise<void> {
	const conversation = await lockThread(tx, threadId);
	if (!conversation) {
		return;
	}
	await appendEntry(tx, conversation, {kind: 'event', text, isError}, wakes);
}

/**
 * Sets an alert in the conversation, from the call that set it: a timed one's job, due at its
 * time; a watch's polls, one per connection it watches, made where there is none, due now for a
 * first look. The same call again, a tool job tried again, gives the alert it set.
 */
export async function createAlert(
	thread: ThreadRow,
	callId: string,
	alert: NewAlert,
): Promise<Result<AlertRow, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const existing = await tx.agentAlert.findFirst({
				where: {threadId: thread.id, callId},
				select: alertSelect,
			});
			if (existing) {
				return existing;
			}
			const made = await tx.agentAlert.create({
				data: {
					orgId: thread.orgId,
					agentId: thread.agentId,
					personaId: thread.personaId,
					userId: thread.userId,
					threadId: thread.id,
					callId,
					title: alert.title,
					brief: alert.brief,
					...(alert.kind === 'time'
						? {at: alert.at}
						: {
								collectionId: alert.collectionId,
								connectionIds: alert.connectionIds,
								criteria: JSON.stringify(alert.criteria),
							}),
				},
				select: alertSelect,
			});
			if (alert.kind === 'time') {
				await tx.agentJob.create({
					data: {threadId: thread.id, kind: 'alert', alertId: made.id, runAt: alert.at},
				});
				return made;
			}
			for (const connectionId of alert.connectionIds) {
				await tx.connectionPoll.upsert({
					where: {connectionId_collectionId: {connectionId, collectionId: alert.collectionId}},
					create: {orgId: thread.orgId, connectionId, collectionId: alert.collectionId},
					update: {},
				});
			}
			return made;
		}),
	);
}

/** An alert by id; `Ok(null)` when it is gone. */
export async function getAlert(alertId: string): Promise<Result<AlertRow | null, ApiError>> {
	return wrapDb(() => db.agentAlert.findUnique({where: {id: alertId}, select: alertSelect}));
}

/** The alerts set in the conversation that haven't ended, oldest first: what the agent is told it has. */
export async function listThreadAlerts(threadId: string): Promise<Result<AlertRow[], ApiError>> {
	return wrapDb(() =>
		db.agentAlert.findMany({
			where: {threadId, endedAt: null},
			select: alertSelect,
			orderBy: {createdAt: 'asc'},
		}),
	);
}

/** An alert as the Alerts page lists it: with the persona it was set with, its latest matches, newest first, and how many there are. */
export type ListedAlert = AlertRow & {persona: PersonaRow; matches: MatchRow[]; matchCount: number};

// How many of a watch's matches the list carries.
const LISTED_MATCHES = 5;

/** The member's alerts in the organization, newest first. */
export async function listMemberAlerts(
	orgId: string,
	userId: string,
): Promise<Result<ListedAlert[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentAlert.findMany({
				where: {orgId, userId},
				select: {
					...alertSelect,
					thread: {select: {persona: {select: personaSelect}}},
					matches: {select: matchSelect, orderBy: {createdAt: 'desc'}, take: LISTED_MATCHES},
					_count: {select: {matches: true}},
				},
				orderBy: {createdAt: 'desc'},
			}),
		)
	).map((alerts) =>
		alerts.map(({thread, matches, _count, ...alert}) => ({
			...alert,
			persona: toPersona(thread.persona),
			matches,
			matchCount: _count.matches,
		})),
	);
}

/** The organization's polls: what each connection's collection was last polled for, and with what error. */
export async function listPolls(orgId: string): Promise<Result<PollRow[], ApiError>> {
	return wrapDb(() => db.connectionPoll.findMany({where: {orgId}, select: pollSelect}));
}

/** Ends an alert set in the conversation, as the agent asked; `Ok(false)` when there is none such still going. A timed one's job goes with it. */
export async function endAlert(
	threadId: string,
	alertId: string,
	by: AlertEnd,
	now: Date,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const {count} = await tx.agentAlert.updateMany({
				where: {id: alertId, threadId, endedAt: null},
				data: {endedAt: now, endedBy: by},
			});
			if (count === 0) {
				return false;
			}
			await tx.agentJob.deleteMany({where: {alertId, status: 'queued'}});
			return true;
		}),
	);
}

/** Deletes one of the member's alerts, ended or not, with its matches; `Ok(false)` when there is no such alert of theirs. A timed one's job goes with it; a watch's polls end themselves once no watch is on them. */
export async function deleteAlert(
	orgId: string,
	userId: string,
	alertId: string,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const {count} = await tx.agentAlert.deleteMany({where: {id: alertId, orgId, userId}});
			if (count === 0) {
				return false;
			}
			await tx.agentJob.deleteMany({where: {alertId, status: 'queued'}});
			return true;
		}),
	);
}

/**
 * Finishes a timed alert's job by firing it: `text` lands in the conversation it was set in, as
 * an event, for the agent to tell the person, and the alert has ended, fired. `Ok(false)` when
 * the job was no longer the worker's, and nothing is written; an alert gone or ended meanwhile
 * takes nothing, the job done.
 */
export async function fireAlert(
	jobId: string,
	workerId: string,
	alertId: string,
	text: string,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const alert = await lockAlert(tx, alertId);
			const conversation = alert ? await lockThread(tx, alert.threadId) : null;
			if (!(await fence(tx, jobId, workerId, 'done'))) {
				return false;
			}
			if (!alert || !conversation || alert.endedAt !== null) {
				return true;
			}
			const now = new Date();
			await tx.agentAlert.update({
				where: {id: alert.id},
				data: {endedAt: now, endedBy: 'fired'},
			});
			await appendEntry(tx, conversation, {kind: 'event', text, jobId}, wakes);
			return true;
		}),
	);
}

/**
 * Claims the next poll due for `workerId`: one unclaimed whose time has come, or one claimed whose
 * worker's lease ran out, the earliest due first. `Ok(null)` when none is due. The claim holds for
 * `leaseMs`, and `renewPollLease` keeps it.
 */
export async function claimPoll(
	workerId: string,
	leaseMs: number,
): Promise<Result<PollRow | null, ApiError>> {
	// As claimJob: compared and written as the UTC wall clock.
	return wrapDb(async () => {
		const rows = await db.$queryRaw<Array<PollRow>>`
			UPDATE "ConnectionPoll" SET
				"claimedBy" = ${workerId},
				"leaseExpiresAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}),
				"updatedAt" = now() AT TIME ZONE 'UTC'
			WHERE "id" = (
				SELECT "id" FROM "ConnectionPoll"
				WHERE ("claimedBy" IS NULL AND "nextAt" <= now() AT TIME ZONE 'UTC')
					OR ("claimedBy" IS NOT NULL AND "leaseExpiresAt" < now() AT TIME ZONE 'UTC')
				ORDER BY "nextAt" ASC
				LIMIT 1
				FOR UPDATE SKIP LOCKED
			)
			RETURNING "id", "orgId", "connectionId", "collectionId", "cursor", "nextAt", "claimedBy", "lastPolledAt", "lastError"`;
		return rows[0] ?? null;
	});
}

/** Keeps the worker's claim on the poll; `Ok(false)` when the poll is no longer its. */
export async function renewPollLease(
	pollId: string,
	workerId: string,
	leaseMs: number,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(
			() => db.$executeRaw`
				UPDATE "ConnectionPoll" SET "leaseExpiresAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}), "updatedAt" = now() AT TIME ZONE 'UTC'
				WHERE "id" = ${pollId} AND "claimedBy" = ${workerId}`,
		)
	).map((count) => count > 0);
}

/** The watches on the connection's collection still going, oldest first. */
export async function listPollRules(
	connectionId: string,
	collectionId: string,
): Promise<Result<AlertRow[], ApiError>> {
	return wrapDb(() =>
		db.agentAlert.findMany({
			where: {collectionId, connectionIds: {has: connectionId}, endedAt: null},
			select: alertSelect,
			orderBy: {createdAt: 'asc'},
		}),
	);
}

/** Deletes a poll, once no watch is on it, or its connection is gone. */
export async function deletePoll(pollId: string): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.connectionPoll.deleteMany({where: {id: pollId}}))).map(
		() => undefined,
	);
}

/**
 * Finishes the worker's poll with what it came to: where it left off, when the next is due, what
 * it failed with if it did; and each watch's matches, kept, those matched before left out, and
 * told in the watch's conversation where any are new, which wakes the agent where the log then
 * `wakes` it. A watch ended or gone meanwhile takes nothing. `Ok(false)` when the poll was no
 * longer the worker's, and nothing is written.
 */
export async function finishPoll(
	pollId: string,
	workerId: string,
	outcome: PollOutcome,
	tell: MatchTell,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const now = new Date();
			const {count} = await tx.connectionPoll.updateMany({
				where: {id: pollId, claimedBy: workerId},
				data: {
					cursor: outcome.cursor,
					nextAt: outcome.nextAt,
					lastPolledAt: now,
					lastError: outcome.error,
					claimedBy: null,
					leaseExpiresAt: null,
				},
			});
			if (count === 0) {
				return false;
			}
			const poll = await tx.connectionPoll.findUnique({where: {id: pollId}, select: pollSelect});
			if (!poll) {
				return true;
			}
			for (const {alert, items} of outcome.matches) {
				const current = await lockAlert(tx, alert.id);
				if (!current || current.endedAt !== null) {
					continue;
				}
				const before = new Set(
					(
						await tx.alertMatch.findMany({
							where: {alertId: alert.id, recordId: {in: items.map((item) => item.recordId)}},
							select: {recordId: true},
						})
					).map((match) => match.recordId),
				);
				const fresh = items.filter((item) => !before.has(item.recordId));
				if (fresh.length === 0) {
					continue;
				}
				await tx.alertMatch.createMany({
					data: fresh.map((item) => ({
						alertId: alert.id,
						orgId: alert.orgId,
						connectionId: poll.connectionId,
						collectionId: poll.collectionId,
						recordId: item.recordId,
						title: item.title,
						summary: item.summary,
						url: item.url,
					})),
				});
				await tellConversation(tx, current.threadId, tell(current, fresh), false, wakes);
			}
			return true;
		}),
	);
}

/**
 * Takes a connection that is gone out of the watches on its collection: one left watching nothing
 * ends, and its conversation is told, as `tell` says, so the person can have it set again.
 */
export async function dropConnectionFromWatches(
	connectionId: string,
	collectionId: string,
	tell: (alert: AlertRow) => string,
	wakes: Wakes,
): Promise<Result<void, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const watches = await tx.agentAlert.findMany({
				where: {collectionId, connectionIds: {has: connectionId}, endedAt: null},
				select: {id: true},
			});
			for (const {id} of watches) {
				const alert = await lockAlert(tx, id);
				if (!alert || alert.endedAt !== null) {
					continue;
				}
				const remaining = alert.connectionIds.filter((candidate) => candidate !== connectionId);
				if (remaining.length > 0) {
					await tx.agentAlert.update({where: {id}, data: {connectionIds: remaining}});
					continue;
				}
				await tx.agentAlert.update({
					where: {id},
					data: {connectionIds: [], endedAt: new Date(), endedBy: 'connection_gone'},
				});
				await tellConversation(tx, alert.threadId, tell(alert), true, wakes);
			}
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
