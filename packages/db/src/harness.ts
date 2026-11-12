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
	type HarnessSession,
	type Look,
	type LogEntry,
	parseHarnessSession,
	parseLook,
	pendingToolCalls,
	type ThreadState,
	threadState,
	type ToolCall,
} from '@proxy/utils/harness';
import type {EntryAttachment} from '@proxy/utils/harness-context';
import {taskEndedLongAgo} from '@proxy/utils/tasks';

import {db} from '.';
import {signedInAgentSelect, type SignedInAgent, toSignedInAgent} from './signed-in-agent';
import type {NewAgentTask} from './task';

/**
 * The Chat page: the organization's personas, each its maker's but General, which is every
 * member's, with a thread per member who sees it, the member's
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
 * A turn's own output, what the model said and what the calls it ran itself answered, is the
 * running job's to write as it goes (appendTurnEntries), never pending: nothing else lands in the
 * log while the job runs, so the log stays what the model read plus what it did. A harness that
 * keeps a session between turns leaves it on the thread as the job ends (completeInference), and
 * one that answers a sleep itself has the thread woken at the time by a job of its own
 * (scheduleWake), which runs like a turn, telling the harness it was woken, and is not claimed
 * while the turn that asked for it still runs (claimJob).
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
	// Which harness last ran a turn on the thread and left `harnessSession`, by its id; null for a
	// thread no harness left anything on.
	harness: string | null;
	// What that harness kept from the thread's last turn, opaque here; null before the first, for a
	// harness that keeps nothing, and where what the column holds isn't a session.
	harnessSession: HarnessSession;
	createdAt: Date;
};

/** A sub-agent as the agent that started it is told of it: its thread, and what it is up to. */
export type SubAgentRow = ThreadRow & {state: ThreadState};

/** The harness that runs a persona's turns and the model it answers with, each by its id, as kept: what the server has of them is the api's to say. */
export type PersonaModel = {harness: string; chatModel: string};

/**
 * What a persona is: its name and its head, a look and a color, and the harness that runs its
 * turns with the model it answers with, where they are chosen; left as they are otherwise, the
 * database's defaults for a new one.
 */
export type Persona = {name: string; look: Look; color: string} & Partial<PersonaModel>;

/**
 * A persona as the Chat page lists it, with the harness and the model chosen for it, whose it is,
 * null for one every member sees, as General is, who made it, who may change such a one beside
 * the organization's owner, and when.
 */
export type PersonaRow = Omit<Persona, keyof PersonaModel> &
	PersonaModel & {
		id: string;
		ownerUserId: string | null;
		createdById: string | null;
		createdAt: Date;
	};

export type EntryRow = LogEntry & {
	id: string;
	seq: number;
	threadId: string;
	// Landed while the model was answering: not in the log until the answer is.
	pending: boolean;
	isError: boolean;
	// A sub-agent's person entry the member wrote in its chat, rather than the agent that started it.
	direct: boolean;
	inputTokens: number | null;
	outputTokens: number | null;
	// A summary entry's reach: the seq of the last entry it stands for.
	coversSeq: number | null;
	// An assistant entry's system prompt, as the model was sent it; null where it wasn't run.
	system: string | null;
	// An assistant entry's harness and model, by their ids, as the turn that wrote it ran; null
	// where the model wasn't run for it.
	harness: string | null;
	model: string | null;
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

/** An entry to land in a thread; `direct` where the member wrote it in a sub-agent's chat. */
export type NewEntry = {kind: AgentEntryKind; text: string; direct?: boolean};

/** The harness and the model a turn ran on, by their ids, kept with what the model answered. */
export type RanOn = {harness: string; model: string};

/**
 * An entry of a turn's own output, as a harness that runs its tools itself tells it: what the
 * model said at a step, with the calls it made there and what the step cost, or what one of those
 * calls answered. `system` is the prompt the model was sent, on the turn's first answer at least;
 * `attachments` the files the answer shows the person, each at the version it held then.
 */
export type NewTurnEntry =
	| {
			kind: 'assistant';
			text: string;
			toolCalls: ToolCall[] | null;
			inputTokens?: number;
			outputTokens?: number;
			system?: string;
			ranOn?: RanOn;
			attachments?: EntryAttachment[];
	  }
	| {kind: 'tool_result'; callId: string; text: string; isError: boolean};

/** The harness that ran a turn and what it kept, as the turn's job ends, for the thread to keep. */
export type ThreadSession = {harness: string; session: HarnessSession};

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
	harness: true,
	harnessSession: true,
	createdAt: true,
} as const;

type ThreadRecord = Prisma.AgentThreadGetPayload<{select: typeof threadSelect}>;

// A thread as read, its harness's session parsed from the JSON it is kept as.
function toThread(thread: ThreadRecord): ThreadRow {
	return {...thread, harnessSession: parseHarnessSession(thread.harnessSession)};
}

// A thread's jobs still to run or running, as much of them as says what its agent is up to.
const openJobsSelect = {
	where: {status: {in: ['queued', 'running']}},
	select: {kind: true, runAt: true},
} satisfies Prisma.AgentThread$jobsArgs;

export const personaSelect = {
	id: true,
	name: true,
	look: true,
	color: true,
	harness: true,
	chatModel: true,
	ownerUserId: true,
	createdById: true,
	createdAt: true,
} as const;

// The organization's personas a member sees: their own, and those every member does.
function seenBy(orgId: string, userId: string) {
	return {
		orgId,
		OR: [{ownerUserId: userId}, {ownerUserId: null}],
	} satisfies Prisma.PersonaWhereInput;
}

export function toPersona(persona: {
	id: string;
	name: string;
	look: string;
	color: string;
	harness: string;
	chatModel: string;
	ownerUserId: string | null;
	createdById: string | null;
	createdAt: Date;
}): PersonaRow {
	return {...persona, look: parseLook(persona.look)};
}

/** The columns of an entry, as `EntryRow` has them; the admin reads with it too. */
export const entrySelect = {
	id: true,
	seq: true,
	threadId: true,
	kind: true,
	pending: true,
	text: true,
	toolCalls: true,
	callId: true,
	isError: true,
	direct: true,
	inputTokens: true,
	outputTokens: true,
	coversSeq: true,
	system: true,
	harness: true,
	model: true,
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

export type EntryRecord = Prisma.AgentEntryGetPayload<{select: typeof entrySelect}>;

type Tx = Prisma.TransactionClient;

/** An entry as read, its calls parsed. */
export function toEntry(entry: EntryRecord): EntryRow {
	return {
		...entry,
		toolCalls: entry.toolCalls === null ? null : (JSON.parse(entry.toolCalls) as ToolCall[]),
	};
}

/**
 * The organization's personas the member sees, their own and those every member does, with the
 * last thing said in the member's conversation with each, what they typed in it and the files they
 * put in its input and haven't sent, the one last active first: the last thing said in it, or,
 * before anything was, its making.
 */
export async function listPersonas(
	orgId: string,
	userId: string,
): Promise<
	Result<
		Array<
			PersonaRow & {
				lastMessage: LastMessage | null;
				draft: string | null;
				draftAttachments: DraftAttachment[];
			}
		>,
		ApiError
	>
> {
	return (
		await wrapDb(() =>
			db.persona.findMany({
				where: seenBy(orgId, userId),
				select: {
					...personaSelect,
					threads: {
						where: {userId, parentThreadId: null},
						select: {
							draft: true,
							attachments: {
								where: {entryId: null},
								select: draftSelect,
								orderBy: {position: 'asc'},
							},
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
				orderBy: {createdAt: 'desc'},
			}),
		)
	).map((personas) =>
		personas
			.map(({threads, ...persona}) => {
				const last = threads[0]?.entries[0];
				return {
					...toPersona(persona),
					lastMessage:
						last && (last.kind === 'person' || last.kind === 'assistant')
							? {kind: last.kind, text: last.text, createdAt: last.createdAt}
							: null,
					draft: threads[0]?.draft ?? null,
					draftAttachments: threads[0]?.attachments ?? [],
				};
			})
			.toSorted((a, b) => lastActive(b).getTime() - lastActive(a).getTime()),
	);
}

// When a persona was last active in the member's conversation with it: the last thing said, or
// its making before anything was.
function lastActive(persona: PersonaRow & {lastMessage: LastMessage | null}): Date {
	return persona.lastMessage?.createdAt ?? persona.createdAt;
}

/** The persona's last answer in a member's conversation with it, and whether they haven't seen it. */
export type ConversationAnswer = {
	personaId: string;
	personaName: string;
	answer: LastAnswer;
	unread: boolean;
};

/**
 * The persona's last answer in each of the member's conversations that has one, and whether it is
 * unread; one query, and nothing made, for what is asked every so often. Each conversation's
 * answer is found on its own, from the newest entry back by the `(threadId, seq)` index, so a long
 * conversation is not read whole for its last answer.
 */
export async function listAnswers(
	orgId: string,
	userId: string,
): Promise<Result<ConversationAnswer[], ApiError>> {
	return (
		await wrapDb(
			() => db.$queryRaw<
				Array<{
					personaId: string;
					personaName: string;
					id: string;
					text: string;
					unread: boolean;
				}>
			>`
				SELECT t."personaId", p."name" AS "personaName", e."id", e."text",
					e."seq" > t."readSeq" AS "unread"
				FROM "AgentThread" AS t
				JOIN "Persona" AS p ON p."id" = t."personaId"
				CROSS JOIN LATERAL (
					SELECT "id", "seq", "text"
					FROM "AgentEntry"
					WHERE "threadId" = t."id" AND "kind" = 'assistant' AND "text" <> ''
					ORDER BY "seq" DESC
					LIMIT 1
				) AS e
				WHERE t."orgId" = ${orgId} AND t."userId" = ${userId} AND t."parentThreadId" IS NULL
			`,
		)
	).map((rows) =>
		rows.map(({personaId, personaName, id, text, unread}) => ({
			personaId,
			personaName,
			answer: {id, text},
			unread,
		})),
	);
}

/**
 * The organization's first persona, General, every member's, made by nobody in particular where
 * it has none every member sees: the organization's row is locked meanwhile, so two first
 * openings of Chat make one. The one there is otherwise, which is the oldest of them.
 */
export async function ensureFirstPersona(orgId: string): Promise<Result<PersonaRow, ApiError>> {
	return (
		await wrapDb(() =>
			db.$transaction(async (tx) => {
				await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${orgId} FOR UPDATE`;
				const existing = await tx.persona.findFirst({
					where: {orgId, ownerUserId: null},
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

/** One of the organization's personas the member sees; `Ok(null)` for none, another member's own among them. */
export async function getPersona(
	orgId: string,
	userId: string,
	personaId: string,
): Promise<Result<PersonaRow | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.persona.findFirst({
				where: {id: personaId, ...seenBy(orgId, userId)},
				select: personaSelect,
			}),
		)
	).map((persona) => (persona ? toPersona(persona) : null));
}

/** A new persona in the organization, the member's own, which they made. */
export async function createPersona(
	orgId: string,
	userId: string,
	persona: Persona,
): Promise<Result<PersonaRow, ApiError>> {
	return (
		await wrapDb(() =>
			db.persona.create({
				data: {
					orgId,
					ownerUserId: userId,
					createdById: userId,
					name: persona.name,
					look: JSON.stringify(persona.look),
					color: persona.color,
					harness: persona.harness,
					chatModel: persona.chatModel,
				},
				select: personaSelect,
			}),
		)
	).map(toPersona);
}

/** Renames a persona, changes its head, the harness that runs its turns or the model it answers with; `Ok(false)` means no such persona in the organization. */
export async function updatePersona(
	orgId: string,
	personaId: string,
	persona: Persona,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.persona.updateMany({
				where: {id: personaId, orgId},
				data: {
					name: persona.name,
					look: JSON.stringify(persona.look),
					color: persona.color,
					harness: persona.harness,
					chatModel: persona.chatModel,
				},
			}),
		)
	).map(({count}) => count > 0);
}

/** Deletes a persona with every conversation with it; `Ok(false)` means no such persona in the organization. */
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
	return (
		await wrapDb(() =>
			db.agentThread.findFirst({
				where: {personaId, userId, parentThreadId: null},
				select: threadSelect,
			}),
		)
	).map((thread) => (thread ? toThread(thread) : null));
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
	return (
		await wrapDb(() =>
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
		)
	).map(toThread);
}

/** The last thing said in a thread, by the person or the agent. */
export type LastMessage = {kind: 'person' | 'assistant'; text: string; createdAt: Date};

/** The persona's last answer in a conversation, which the member may not have seen. */
export type LastAnswer = {id: string; text: string};

/**
 * Marks the thread read up to the entry, as far as the member was shown it, never back: what the
 * persona said after it stays unread. `Ok(false)` means no such entry in the thread.
 */
export async function markThreadRead(
	threadId: string,
	entryId: string,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(
			() =>
				db.$executeRaw`UPDATE "AgentThread" AS t SET "readSeq" = GREATEST(t."readSeq", e."seq") FROM "AgentEntry" AS e WHERE t."id" = ${threadId} AND e."id" = ${entryId} AND e."threadId" = t."id"`,
		)
	).map((count) => count > 0);
}

/** What the member typed in their conversation and hasn't sent; `Ok(null)` for none, or no such thread. */
export async function getThreadDraft(threadId: string): Promise<Result<string | null, ApiError>> {
	return (
		await wrapDb(() => db.agentThread.findUnique({where: {id: threadId}, select: {draft: true}}))
	).map((thread) => thread?.draft ?? null);
}

/**
 * A file in a conversation's input, not sent yet: one of a drive's, by its connection, its id
 * there and the version it held when it was put there, with its name, kind and size then. Kept
 * as a file attached to an entry is (AgentEntryAttachment), with no entry yet.
 */
export type DraftAttachment = Omit<EntryAttachment, 'text' | 'cut'>;

const draftSelect = {
	connectionId: true,
	fileId: true,
	version: true,
	name: true,
	type: true,
	size: true,
} as const;

// The files in a conversation's input: its attachments with no entry yet.
function inInput(threadId: string) {
	return {threadId, entryId: null};
}

/** The files the member put in their conversation's input and hasn't sent, in the order they sit there; none for no such thread. */
export function listDraftAttachments(
	threadId: string,
): Promise<Result<DraftAttachment[], ApiError>> {
	return wrapDb(() =>
		db.agentEntryAttachment.findMany({
			where: inInput(threadId),
			select: draftSelect,
			orderBy: {position: 'asc'},
		}),
	);
}

// The member's own conversation, locked for a change to its input; null for none, and for a
// sub-agent's thread, which keeps no input.
async function lockInput(tx: Tx, threadId: string): Promise<ThreadRow | null> {
	const thread = await lockThread(tx, threadId);
	return thread && thread.parentThreadId === null ? thread : null;
}

/**
 * Puts a file in the conversation's input, after those there; one there already, at the same
 * version, is there once. A conflict where it holds `max` already. `Ok(false)` means no such
 * conversation.
 */
export function addDraftAttachment(
	threadId: string,
	attachment: DraftAttachment,
	max: number,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (!(await lockInput(tx, threadId))) {
				return false;
			}
			const kept = await tx.agentEntryAttachment.findMany({
				where: inInput(threadId),
				select: {connectionId: true, fileId: true, version: true, position: true},
				orderBy: {position: 'asc'},
			});
			if (kept.some((one) => sameFile(one, attachment))) {
				return true;
			}
			if (kept.length >= max) {
				throw ApiErr.conflict(`A message carries at most ${max} files.`);
			}
			const position = (kept.at(-1)?.position ?? -1) + 1;
			await tx.agentEntryAttachment.create({
				data: {...attachment, ...inInput(threadId), position},
				select: {id: true},
			});
			return true;
		}),
	);
}

/** Takes a file out of the conversation's input; the file itself stays where it is kept. `Ok(false)` means no such conversation. */
export function removeDraftAttachment(
	threadId: string,
	file: Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (!(await lockInput(tx, threadId))) {
				return false;
			}
			await tx.agentEntryAttachment.deleteMany({where: {...inInput(threadId), ...file}});
			return true;
		}),
	);
}

function sameFile(
	one: Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>,
	other: Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>,
): boolean {
	return (
		one.connectionId === other.connectionId &&
		one.fileId === other.fileId &&
		one.version === other.version
	);
}

/**
 * Keeps what the member typed in their conversation and hasn't sent, in place of what was kept;
 * null forgets it. With `order`, the files in the input are kept in that order, as they sit among
 * what was typed, any it doesn't name after them; none are put there or taken out by it.
 * `Ok(false)` means no such conversation: a sub-agent's thread keeps none.
 */
export async function saveThreadDraft(
	threadId: string,
	draft: string | null,
	order?: Array<Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>>,
): Promise<Result<boolean, ApiError>> {
	if (order === undefined) {
		return (
			await wrapDb(() =>
				db.agentThread.updateMany({where: {id: threadId, parentThreadId: null}, data: {draft}}),
			)
		).map(({count}) => count > 0);
	}
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (!(await lockInput(tx, threadId))) {
				return false;
			}
			await tx.agentThread.update({where: {id: threadId}, data: {draft}});
			const kept = await tx.agentEntryAttachment.findMany({
				where: inInput(threadId),
				select: {id: true, connectionId: true, fileId: true, version: true},
				orderBy: {position: 'asc'},
			});
			const named = new Set(order.flatMap((file) => kept.filter((one) => sameFile(one, file))));
			const ordered = [...named, ...kept.filter((one) => !named.has(one))];
			for (const [position, one] of ordered.entries()) {
				await tx.agentEntryAttachment.update({where: {id: one.id}, data: {position}});
			}
			return true;
		}),
	);
}

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

/**
 * The harness and the model chosen for the thread's persona, its sub-agents' too, as kept;
 * `Ok(null)` where the persona is gone.
 */
export async function getThreadPersonaModel(
	thread: ThreadRow,
): Promise<Result<PersonaModel | null, ApiError>> {
	return wrapDb(() =>
		db.persona.findUnique({
			where: {id: thread.personaId},
			select: {harness: true, chatModel: true},
		}),
	);
}

/** The name of the thread's persona, its sub-agents' too; `Ok(null)` where the persona is gone. */
export async function getThreadPersonaName(
	thread: ThreadRow,
): Promise<Result<string | null, ApiError>> {
	const found = await wrapDb(() =>
		db.persona.findUnique({where: {id: thread.personaId}, select: {name: true}}),
	);
	return found.map((persona) => persona?.name ?? null);
}

/** The thread a job is for, by the job; `Ok(null)` when it is gone. */
export async function getJobThread(threadId: string): Promise<Result<ThreadRow | null, ApiError>> {
	return (
		await wrapDb(() => db.agentThread.findUnique({where: {id: threadId}, select: threadSelect}))
	).map((thread) => (thread ? toThread(thread) : null));
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

// An assistant entry with a call of the tool among its calls, as they are kept: as JSON, each
// call's name written as JSON.stringify writes it.
function withCall(tool: string): Prisma.AgentEntryWhereInput {
	return {kind: 'assistant', toolCalls: {contains: `"name":${JSON.stringify(tool)}`}};
}

/**
 * The thread's turns as the person sees them, what was said and what was answered in words, and
 * the answers that made a call of one of the tools in `calls`, which the person sees as what the
 * call did; and the answers that end a turn without a word, which show nothing but where the turn
 * ended; not the other calls, their results, the reports, the notes or the summaries: the log's,
 * then what is pending, each in order.
 */
export async function listShownEntries(
	threadId: string,
	calls: string[],
): Promise<Result<EntryRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentEntry.findMany({
				where: {
					threadId,
					OR: [
						{kind: 'person'},
						{kind: 'assistant', text: {not: ''}},
						{kind: 'assistant', toolCalls: null},
						...calls.map(withCall),
					],
				},
				select: entrySelect,
				orderBy: [{pending: 'asc'}, {seq: 'asc'}],
			}),
		)
	).map((entries) => entries.map(toEntry));
}

/**
 * A sub-agent's chat, as the member sees it: its thread's turns as `listShownEntries` has them,
 * but for the answers that end a turn without a word, and what of what it told the thread it was
 * started from was an error, its failures, which only that thread's log has: the logs', then what
 * is pending, each in order.
 */
export async function listShownSubAgentEntries(
	subAgent: ThreadRow,
	calls: string[],
): Promise<Result<EntryRow[], ApiError>> {
	const failures: Prisma.AgentEntryWhereInput[] =
		subAgent.parentThreadId === null || subAgent.parentCallId === null
			? []
			: [
					{
						threadId: subAgent.parentThreadId,
						kind: 'event',
						callId: subAgent.parentCallId,
						isError: true,
					},
				];
	return (
		await wrapDb(() =>
			db.agentEntry.findMany({
				where: {
					OR: [
						{
							threadId: subAgent.id,
							OR: [{kind: 'person'}, {kind: 'assistant', text: {not: ''}}, ...calls.map(withCall)],
						},
						...failures,
					],
				},
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
		threads.map(({jobs, ...thread}) => ({...toThread(thread), state: threadState(jobs, now)})),
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
export async function lockThread(tx: Tx, threadId: string): Promise<ThreadRow | null> {
	const rows = await tx.$queryRaw<Array<{id: string}>>`
		SELECT "id" FROM "AgentThread"
		WHERE "id" = (SELECT COALESCE("parentThreadId", "id") FROM "AgentThread" WHERE "id" = ${threadId})
		FOR UPDATE`;
	if (rows.length === 0) {
		return null;
	}
	const thread = await tx.agentThread.findUnique({where: {id: threadId}, select: threadSelect});
	return thread ? toThread(thread) : null;
}

// The jobs that run the model on the thread: a turn, or a wake-up after a sleep, which is a turn too.
const TURN_KINDS: AgentJobKind[] = ['inference', 'wake'];

// Queues an inference job for the thread unless a turn, an inference or a wake job, is queued or
// running already: a wake-up due later runs the model on the log as it is then, what lands
// meanwhile included, so it is turn enough. With the thread locked.
async function queueInference(tx: Tx, thread: ThreadRow): Promise<void> {
	const active = await tx.agentJob.count({
		where: {threadId: thread.id, kind: {in: TURN_KINDS}, status: {in: ['queued', 'running']}},
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

// Whether what lands now has to wait: a turn, an inference or a wake job, runs on the thread,
// whose answer comes first, or the model's last answer has calls without their results yet, which
// have to follow it directly, as the model reads them; anything between them and it is refused.
// With the thread locked.
async function holding(tx: Tx, thread: ThreadRow): Promise<boolean> {
	const running = await tx.agentJob.count({
		where: {threadId: thread.id, kind: {in: TURN_KINDS}, status: 'running'},
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
export async function appendEntry(
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
	await answerCall(
		tx,
		toThread(parent),
		'event',
		{callId: thread.parentCallId, ...message},
		jobId,
		wakes,
	);
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

/** A sub-agent the member pinned, as a task, under its persona: when it last had something in its log, or its start before anything did. */
export type PinnedTaskRow = {id: string; personaId: string; title: string; lastActiveAt: Date};

/**
 * The sub-agents the member pinned in their conversations in the organization, as tasks, the one
 * with something in its log last first.
 */
export async function listPinnedTasks(
	orgId: string,
	userId: string,
): Promise<Result<PinnedTaskRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentThread.findMany({
				where: {orgId, userId, parentThreadId: {not: null}, pinnedAt: {not: null}},
				select: {
					id: true,
					personaId: true,
					title: true,
					createdAt: true,
					entries: {orderBy: {seq: 'desc'}, take: 1, select: {createdAt: true}},
				},
			}),
		)
	).map((threads) =>
		threads
			.map(({entries, createdAt, title, ...thread}) => ({
				...thread,
				title: title ?? '',
				lastActiveAt: entries[0]?.createdAt ?? createdAt,
			}))
			.toSorted((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime()),
	);
}

/** Pins one of the conversation's sub-agents, as a task, or unpins it; `Ok(false)` means no such sub-agent of the conversation. */
export async function setTaskPinned(
	conversationId: string,
	subAgentId: string,
	pinned: boolean,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.agentThread.updateMany({
				where: {id: subAgentId, parentThreadId: conversationId},
				data: {pinnedAt: pinned ? new Date() : null},
			}),
		)
	).map(({count}) => count > 0);
}

/**
 * Lands what the member wrote in the chat of one of their conversation's sub-agents: in the
 * sub-agent's log, as theirs (`direct`), taking it up as the agent's message would
 * (messageSubAgent); and in the conversation, as a note on the call that started it, which the
 * agent reads with what wakes it next, the sub-agent's answer among it, but is not woken by where
 * `wakes` says so (@proxy/utils/harness readyForInference); with the files they attached, kept with
 * both. `Ok(false)` means no such sub-agent of the conversation.
 */
export async function messageSubAgentDirectly(
	conversationId: string,
	subAgentId: string,
	text: string,
	wakes: Wakes,
	attachments: EntryAttachment[] = [],
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const conversation = await lockThread(tx, conversationId);
			if (!conversation || conversation.parentThreadId !== null) {
				return false;
			}
			const subAgent = await messageSubAgent(
				tx,
				conversation,
				subAgentId,
				{kind: 'person', text, direct: true},
				wakes,
				attachments,
			);
			if (!subAgent) {
				return false;
			}
			const note = await appendEntry(
				tx,
				conversation,
				{
					kind: 'note',
					text,
					...(subAgent.parentCallId === null ? {} : {callId: subAgent.parentCallId}),
				},
				wakes,
			);
			await attach(tx, conversation.id, note.id, attachments);
			return true;
		}),
	);
}

/**
 * Lands what the person said, and wakes the agent where the log `wakes` it; what they had typed
 * and not sent goes with it, since this is it sent. `Ok(null)` means no such thread.
 */
export async function appendPersonMessage(
	threadId: string,
	text: string,
	wakes: Wakes,
	attachments: EntryAttachment[] = [],
): Promise<Result<EntryRow | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, threadId);
			if (!thread) {
				return null;
			}
			await tx.agentThread.update({where: {id: threadId}, data: {draft: null}});
			await tx.agentEntryAttachment.deleteMany({where: inInput(threadId)});
			const entry = await appendEntry(tx, thread, {kind: 'person', text}, wakes);
			await attach(tx, threadId, entry.id, attachments);
			return entry;
		}),
	);
}

// Keeps the files an entry goes with, in the order given.
async function attach(
	tx: Tx,
	threadId: string,
	entryId: string,
	attachments: EntryAttachment[] = [],
): Promise<void> {
	if (attachments.length === 0) {
		return;
	}
	await tx.agentEntryAttachment.createMany({
		data: attachments.map((attachment, position) => ({...attachment, entryId, threadId, position})),
	});
}

const attachmentSelect = {
	entryId: true,
	connectionId: true,
	fileId: true,
	version: true,
	name: true,
	type: true,
	size: true,
	text: true,
	cut: true,
} as const;

/**
 * A file attached to an entry of a thread's log, with the entry it is attached to, and whether the
 * version attached is gone from its drive since, deleted for good with the file out of the trash
 * or with the drive: only what the log kept of it is left then.
 */
export type AttachmentRow = EntryAttachment & {entryId: string; gone: boolean};

/**
 * The files of a thread's log, each with the entry it goes with, in the order attached: what the
 * person attached to what they said, and the files the agent showed them in its answers.
 */
export function listAttachments(threadId: string): Promise<Result<AttachmentRow[], ApiError>> {
	return wrapDb(async () => {
		const rows = await db.agentEntryAttachment.findMany({
			where: {threadId, entryId: {not: null}},
			select: attachmentSelect,
			orderBy: [{createdAt: 'asc'}, {position: 'asc'}],
		});
		const kept = await db.fileVersion.findMany({
			where: {id: {in: [...new Set(rows.map((row) => row.version))]}},
			select: {id: true},
		});
		const there = new Set(kept.map((version) => version.id));
		return rows.flatMap(({entryId, ...row}) =>
			entryId === null ? [] : [{...row, entryId, gone: !there.has(row.version)}],
		);
	});
}

/**
 * Whether the person attached the version of the file in the conversation the task's work is for:
 * the thread of a sub-agent whose task it is, and the conversation that thread was started from.
 * False for a task that is no sub-agent's. A file the agent showed them hands nothing over: the
 * agent could read it already.
 */
export async function isAttachedForTask(
	task: {orgId: string; taskId: string},
	file: {connectionId: string; fileId: string; version: string},
): Promise<Result<boolean, ApiError>> {
	return wrapDb(async () => {
		const thread = await db.agentThread.findFirst({
			where: task,
			select: {id: true, parentThreadId: true},
		});
		if (!thread) {
			return false;
		}
		const found = await db.agentEntryAttachment.findFirst({
			where: {
				threadId: {in: [thread.id, ...(thread.parentThreadId ? [thread.parentThreadId] : [])]},
				entry: {kind: 'person' satisfies AgentEntryKind},
				...file,
			},
			select: {entryId: true},
		});
		return found !== null;
	});
}

/** A job as a worker claimed it, with whether it is a turn of a persona on the harness the claim was told is capped. */
export type ClaimedJob = JobRow & {capped: boolean};

/** The harness whose turns a worker runs only so many of at once, by its id, and whether the worker has no room for another. */
export type CappedHarness = {harness: string; full: boolean};

/**
 * Claims the next job due for `workerId`: one queued whose time has come, or one running whose
 * worker's lease ran out, the earliest due first. A turn queued for a thread that has another
 * running, as a wake-up is that a sleep the turn itself answered asked for (scheduleWake), is not
 * due until that one has ended, whoever holds it: two turns never run on one thread. With
 * `capped`, the claim says whether the job is a turn of a persona on that harness, and, where the
 * worker is `full`, leaves those turns for later, or for another worker: the api runs only so many
 * of them at once, and a worker that has no room for another claims the other jobs meanwhile.
 * `Ok(null)` when none is due. The claim holds for `leaseMs`, and `renewLease` keeps it.
 */
export async function claimJob(
	workerId: string,
	leaseMs: number,
	capped: CappedHarness | null = null,
): Promise<Result<ClaimedJob | null, ApiError>> {
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
					SELECT job."id" FROM "AgentJob" job
					WHERE (
							(job."status" = 'queued' AND job."runAt" <= now() AT TIME ZONE 'UTC')
							OR (job."status" = 'running' AND job."leaseExpiresAt" < now() AT TIME ZONE 'UTC')
						)
						AND NOT (
							job."status" = 'queued'
							AND job."kind" IN ('inference', 'wake')
							AND EXISTS (
								SELECT 1 FROM "AgentJob" turn
								WHERE turn."threadId" = job."threadId"
									AND turn."id" <> job."id"
									AND turn."kind" IN ('inference', 'wake')
									AND turn."status" = 'running'
							)
						)
						AND NOT (
							${capped?.full ?? false}
							AND job."kind" IN ('inference', 'wake')
							AND EXISTS (
								SELECT 1 FROM "AgentThread" thread
								JOIN "Persona" persona ON persona."id" = thread."personaId"
								WHERE thread."id" = job."threadId" AND persona."harness" = ${capped?.harness ?? ''}
							)
						)
					ORDER BY job."runAt" ASC
					LIMIT 1
					FOR UPDATE OF job SKIP LOCKED
				)
				RETURNING "id", "threadId", "kind", "status", "entryId", "callId", "runAt", "claimedBy", "attempts"`;
			const job = rows[0];
			if (!job) {
				return null;
			}
			await tx.agentJobEvent.create({
				data: {jobId: job.id, threadId: job.threadId, kind: 'claimed', workerId},
			});
			if (capped === null || !TURN_KINDS.includes(job.kind)) {
				return {...job, capped: false};
			}
			const turns = await tx.agentThread.count({
				where: {id: job.threadId, persona: {harness: capped.harness}},
			});
			return {...job, capped: turns > 0};
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
export async function endJob(
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

/** What the model answered: its text, its tool calls, what they cost, the system prompt it was sent, null where it wasn't run for the answer, the harness and the model it ran on, left out there, and the files it shows the person, each at the version it held then. */
export type AssistantTurn = {
	text: string;
	toolCalls: ToolCall[];
	inputTokens: number;
	outputTokens: number;
	system: string | null;
	ranOn?: RanOn;
	attachments?: EntryAttachment[];
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
 * Appends a turn's own output as it comes, from the inference job that runs the turn: what the
 * model said at a step, with its calls, and what the calls it ran itself answered, in the order
 * given; the job goes on. The entries are never pending: pending is for what lands from outside
 * while a turn runs, which waits for the turn's output to be in the log first, and this is that
 * output, from the job that holds the thread. `Ok(false)` when the job was no longer the
 * worker's, and nothing is written.
 */
export async function appendTurnEntries(
	jobId: string,
	workerId: string,
	threadId: string,
	entries: NewTurnEntry[],
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockThread(tx, threadId);
			if (!(await held(tx, jobId, workerId))) {
				return false;
			}
			for (const entry of entries) {
				if (entry.kind === 'assistant') {
					const written = await tx.agentEntry.create({
						data: {
							threadId,
							kind: 'assistant' satisfies AgentEntryKind,
							text: entry.text,
							toolCalls:
								entry.toolCalls === null || entry.toolCalls.length === 0
									? null
									: JSON.stringify(entry.toolCalls),
							inputTokens: entry.inputTokens,
							outputTokens: entry.outputTokens,
							system: entry.system,
							harness: entry.ranOn?.harness,
							model: entry.ranOn?.model,
							jobId,
						},
						select: {id: true},
					});
					await attach(tx, threadId, written.id, entry.attachments);
					continue;
				}
				await tx.agentEntry.create({
					data: {
						threadId,
						kind: 'tool_result' satisfies AgentEntryKind,
						callId: entry.callId,
						text: entry.text,
						isError: entry.isError,
						jobId,
					},
					select: {id: true},
				});
			}
			return true;
		}),
	);
}

/**
 * Has the thread's agent woken at `runAt`, from the inference job that runs its turn: what a
 * sleep the harness answered itself comes to, called by the sleep tool while the job runs. The
 * wake job runs the model on the log as it is then, told it was woken (api worker), and no sooner
 * than this turn has ended, however soon it is due (claimJob). A thread has one wake-up queued at
 * most: where one is, it is moved to the earlier of the two times. `Ok(false)`
 * when the job was no longer the worker's, and nothing is written.
 */
export async function scheduleWake(
	jobId: string,
	workerId: string,
	threadId: string,
	runAt: Date,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockThread(tx, threadId);
			if (!(await held(tx, jobId, workerId))) {
				return false;
			}
			const queued = await tx.agentJob.findFirst({
				where: {threadId, kind: 'wake', status: 'queued'},
				select: {id: true, runAt: true},
			});
			if (!queued) {
				await tx.agentJob.create({
					data: {threadId, kind: 'wake' satisfies AgentJobKind, runAt},
					select: {id: true},
				});
				return true;
			}
			if (queued.runAt.getTime() <= runAt.getTime()) {
				return true;
			}
			await tx.agentJob.update({where: {id: queued.id}, data: {runAt}, select: {id: true}});
			return true;
		}),
	);
}

/** The job a harness that runs its tools itself writes from mid-turn: the inference job running the turn, the worker it is leased to, and the thread it is on. */
export type InlineJob = {jobId: string; workerId: string; threadId: string};

/**
 * Runs `write` with the job's conversation locked, where the job is still the worker's and its
 * thread is there: what a call the harness runs itself, mid-turn, writes beside the log, each in a
 * transaction of its own. `absent` when the job is no longer the worker's, or the thread is gone,
 * and nothing is written.
 */
export function writeInline<T, A>(
	job: InlineJob,
	absent: A,
	write: (tx: Tx, thread: ThreadRow) => Promise<T>,
): Promise<Result<T | A, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, job.threadId);
			if (!thread || !(await held(tx, job.jobId, job.workerId))) {
				return absent;
			}
			return write(tx, thread);
		}),
	);
}

/**
 * Starts a sub-agent of the thread's agent from the inference job that runs its turn, where the
 * harness runs the create_subagent call itself: the sub-agent as `completeInference` would start
 * it for a planned call, its task, its thread and its brief, which wakes it; the call's answer,
 * with the id given here, is the turn's to write (appendTurnEntries). `Ok(null)` when the job was
 * no longer the worker's, and nothing is started.
 */
export function startSubAgentInline(
	job: InlineJob,
	start: SubAgentStart,
	wakes: Wakes,
): Promise<Result<string | null, ApiError>> {
	return writeInline(job, null, (tx, thread) => createSubAgent(tx, thread, start, wakes));
}

/**
 * Sends a message to one of the thread's sub-agents from the inference job that runs its turn,
 * where the harness runs the send_to_subagent call itself: as `completeInference` sends one for a
 * planned call, the message in the sub-agent's log, the sub-agent woken or taken up again. What
 * it got: the sub-agent as it was before the message, or `subAgent` null where the thread has no
 * such sub-agent; `Ok(null)` when the job was no longer the worker's, and nothing is sent.
 */
export function messageSubAgentInline(
	job: InlineJob,
	subAgentId: string,
	entry: NewEntry,
	wakes: Wakes,
): Promise<Result<{subAgent: SubAgentRow | null} | null, ApiError>> {
	return writeInline(job, null, async (tx, thread) => ({
		subAgent: await messageSubAgent(tx, thread, subAgentId, entry, wakes),
	}));
}

/**
 * Lands what a sub-agent said in the thread it was started from, from the inference job that
 * runs the sub-agent's turn, where the harness runs the send_to_parent call itself: as
 * `completeInference` does for a planned call, an event answering the call that started the
 * sub-agent, pending where the parent's turn runs. `Ok(false)` when the job was no longer the
 * worker's, and nothing is sent.
 */
export function tellParentInline(
	job: InlineJob,
	message: {text: string; isError: boolean},
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return writeInline(job, false, async (tx, thread) => {
		await tellParent(tx, thread, message, job.jobId, wakes);
		return true;
	});
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
		await appendEntry(tx, toThread(thread), entry, wakes);
	}
	return thread.id;
}

// Lands a message from the agent that started the sub-agent in the sub-agent's log, and wakes the
// sub-agent: one that had stopped takes it up, its task under way again (takeUpSubAgentTask); one at work reads it once
// its current call is answered; and one asleep is woken now, its sleep's job due now, which answers
// the sleep as any wake-up does, the message after it, or its wake-up due now, which reads the
// message. The sub-agent as it was before the message; null when the thread has no such
// sub-agent. With the conversation locked.
async function messageSubAgent(
	tx: Tx,
	parent: ThreadRow,
	subAgentId: string,
	entry: NewEntry,
	wakes: Wakes,
	attachments: EntryAttachment[] = [],
): Promise<SubAgentRow | null> {
	const found = await tx.agentThread.findFirst({
		where: {id: subAgentId, parentThreadId: parent.id},
		select: {...threadSelect, jobs: openJobsSelect},
	});
	if (!found) {
		return null;
	}
	const {jobs, ...record} = found;
	const thread = toThread(record);
	const now = new Date();
	if (thread.taskId !== null) {
		await takeUpSubAgentTask(tx, {...thread, taskId: thread.taskId}, now);
	}
	// Only a sleep's job, the sleep's own or the wake-up that answers it, is due later; one a worker
	// has claimed is no longer queued, and answers as it would.
	await tx.agentJob.updateMany({
		where: {threadId: thread.id, kind: {in: ['tool', 'wake']}, status: 'queued', runAt: {gt: now}},
		data: {runAt: now},
	});
	const appended = await appendEntry(tx, thread, entry, wakes);
	await attach(tx, thread.id, appended.id, attachments);
	return {...thread, state: threadState(jobs, now)};
}

// Puts the sub-agent's task under way again from `now`, as a message wakes it. One that ended,
// finished or left open, more than 20 minutes before stays as it was, and a new one for the same
// work takes its place, so a task long over isn't drawn as under way again (@proxy/utils/tasks).
// With the conversation locked.
async function takeUpSubAgentTask(
	tx: Tx,
	thread: ThreadRow & {taskId: string},
	now: Date,
): Promise<void> {
	const task = await tx.agentTask.findUnique({
		where: {id: thread.taskId},
		select: {
			orgId: true,
			agentId: true,
			ownerUserId: true,
			personaId: true,
			title: true,
			goal: true,
			via: true,
			finishedAt: true,
			lastActiveAt: true,
		},
	});
	if (task === null) {
		return;
	}
	if (!taskEndedLongAgo(task, now)) {
		await tx.agentTask.updateMany({
			where: {id: thread.taskId},
			data: {finishedAt: null, outcome: null, lastActiveAt: now},
		});
		return;
	}
	const {finishedAt: _finishedAt, lastActiveAt: _lastActiveAt, ...work} = task;
	const fresh = await tx.agentTask.create({
		data: {...work, parentId: null, createdAt: now, lastActiveAt: now},
		select: {id: true},
	});
	await tx.agentThread.update({
		where: {id: thread.id},
		data: {taskId: fresh.id},
		select: {id: true},
	});
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
 * Finishes an inference job, or a wake job, with the model's answer: the assistant entry, then
 * what follows it, each of its calls as its plan says, a tool job due when it says or an answer at
 * once (`CallPlan`); or, a sub-agent's answer without calls, what it said to the agent it works
 * for, and its stop where nothing came meanwhile. A call without a plan gets a tool job due now.
 * With `turn` null the answer is in the log already, appended as the turn went
 * (appendTurnEntries): no entry is written, and what follows is planned for the calls of the last
 * answer still open, if any. With `session`, the thread keeps the harness that ran the turn and
 * what it kept, for the next. What landed meanwhile takes its place in the log after the answer,
 * and wakes the agent where the log then `wakes` it. `Ok(false)` when the job was no longer the
 * worker's, and nothing is written.
 */
export async function completeInference(
	jobId: string,
	workerId: string,
	threadId: string,
	turn: AssistantTurn | null,
	after: AfterAnswer,
	wakes: Wakes,
	session?: ThreadSession,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction((tx) =>
			endJob(tx, {jobId, workerId, threadId, status: 'done'}, wakes, async (thread) => {
				if (session) {
					await tx.agentThread.update({
						where: {id: threadId},
						data: {
							harness: session.harness,
							harnessSession: session.session === null ? null : JSON.stringify(session.session),
						},
						select: {id: true},
					});
				}
				if (turn) {
					const written = await tx.agentEntry.create({
						data: {
							threadId,
							kind: 'assistant' satisfies AgentEntryKind,
							text: turn.text,
							toolCalls: turn.toolCalls.length === 0 ? null : JSON.stringify(turn.toolCalls),
							inputTokens: turn.inputTokens,
							outputTokens: turn.outputTokens,
							system: turn.system,
							harness: turn.ranOn?.harness,
							model: turn.ranOn?.model,
							jobId,
						},
						select: {id: true},
					});
					await attach(tx, threadId, written.id, turn.attachments);
				}
				if ('stop' in after) {
					await endTurn(tx, thread, after.stop, jobId, wakes);
					return;
				}
				// The answer's calls without a result: the turn's, just written, or those the log was
				// left with.
				const tail = await tailOf(tx, thread);
				const answer = tail.findLast((entry) => entry.kind === 'assistant');
				if (!answer) {
					return;
				}
				for (const call of pendingToolCalls(tail)) {
					const plan: CallPlan = after.plans[call.id] ?? {kind: 'job', runAt: new Date()};
					if (plan.kind === 'job') {
						await tx.agentJob.create({
							data: {
								threadId,
								kind: 'tool' satisfies AgentJobKind,
								entryId: answer.id,
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
