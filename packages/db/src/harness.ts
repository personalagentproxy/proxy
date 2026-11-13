import {
	type AgentEntryKind,
	type AgentJobEventKind,
	type AgentJobKind,
	type AgentJobStatus,
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
 * member's, with a chat per member who sees it, and the chat's threads, each with its log and its
 * jobs. A chat runs no agent of its own: it keeps what the member typed and hasn't sent, the files
 * in its input and how far they have read, and every message they post in it opens a thread, whose
 * agent answers them there. The member's reply, or an alert set in the thread, takes the thread up
 * again; its answer with no calls ends its turn. Every persona acts through the organization's one
 * built-in agent login, whose grants and activity log are every persona's. Every change to a
 * thread's log or its jobs is made with its chat's row locked, so whatever a transaction writes in
 * a chat or any of its threads, it locks that one row first, and no two transactions wait on each
 * other. The model is run on a log only once it is ready, and nothing lands in the log while it
 * runs, or while a call it made is still open: what comes meanwhile, the member's reply or an
 * alert, is pending until the job ends and every call has its result, then takes its place after
 * them, and wakes the agent again. A worker's write is fenced by its lease: it goes through only
 * while the job is still its. What is written, and when the agent is woken, is the api's to say
 * (its harness): these transactions take it composed.
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
	// The persona the chat is with.
	personaId: string;
	// The member whose chat it is, or whose chat the thread is of.
	userId: string;
	// A thread's chat; null for a chat.
	parentThreadId: string | null;
	// A thread's title; null for a chat.
	title: string | null;
	// The task a thread's calls are made for; null for a chat, which runs no turns.
	taskId: string | null;
	// Which harness last ran a turn on the thread and left `harnessSession`, by its id; null for a
	// thread no harness left anything on.
	harness: string | null;
	// What that harness kept from the thread's last turn, opaque here; null before the first, for a
	// harness that keeps nothing, and where what the column holds isn't a session.
	harnessSession: HarnessSession;
	createdAt: Date;
};

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
 * `runAt`; or an answer at once, as a message to the person is answered, and a call that was no
 * good.
 */
export type CallPlan =
	{kind: 'job'; runAt: Date} | {kind: 'answer'; text: string; isError: boolean};

/**
 * Whether the log, from the model's last answer on and without what is pending, is ready for the
 * model: where it is, the thread is given an inference job, unless it has one or is done.
 */
export type Wakes = (tail: LogEntry[]) => boolean;

/** An entry to land in a thread. */
export type NewEntry = {kind: AgentEntryKind; text: string};

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
 * A thread's answer without calls, which ends its turn: where nothing came meanwhile, its task is
 * finished with `outcome`. Nobody else is told: the member reads the answer in the thread.
 */
export type ThreadEnd = {outcome: string};

/** What follows the model's answer: each of its calls as planned; or, an answer without calls, the end of the turn. */
export type AfterAnswer = {plans: Record<string, CallPlan>} | {end: ThreadEnd};

/**
 * What a failed job writes in its thread, so nobody is left waiting on it: an answer to its call,
 * as the call's result; or the agent's answer, as an error, which ends the thread's turn.
 */
export type FailureNote =
	{kind: 'answer'; callId: string; text: string} | {kind: 'end'; text: string; end: ThreadEnd};

const threadSelect = {
	id: true,
	orgId: true,
	agentId: true,
	personaId: true,
	userId: true,
	parentThreadId: true,
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

// The chat `chat` and its threads, as a condition on the thread `t` in SQL.
function inChatSql(chat: Prisma.Sql, t: Prisma.Sql): Prisma.Sql {
	return Prisma.sql`(${t}."id" = ${chat} OR ${t}."parentThreadId" = ${chat})`;
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
 * last thing said in the member's chat with each, across the chat and its threads, what they typed
 * in it and the files they put in its input and haven't sent, the one last active first: the last
 * thing said in it, or, before anything was, its making.
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
					// The member's chat and its threads.
					threads: {
						where: {userId},
						select: {
							parentThreadId: true,
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
								select: {kind: true, text: true, seq: true, createdAt: true},
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
				const chat = threads.find((thread) => thread.parentThreadId === null);
				const last = threads
					.flatMap((thread) => thread.entries)
					.toSorted((a, b) => b.seq - a.seq)[0];
				return {
					...toPersona(persona),
					lastMessage:
						last && (last.kind === 'person' || last.kind === 'assistant')
							? {kind: last.kind, text: last.text, createdAt: last.createdAt}
							: null,
					draft: chat?.draft ?? null,
					draftAttachments: chat?.attachments ?? [],
				};
			})
			.toSorted((a, b) => lastActive(b).getTime() - lastActive(a).getTime()),
	);
}

// When a persona was last active in the member's chat with it: the last thing said, or its making
// before anything was.
function lastActive(persona: PersonaRow & {lastMessage: LastMessage | null}): Date {
	return persona.lastMessage?.createdAt ?? persona.createdAt;
}

/** The persona's last answer in a member's chat with it, and whether they haven't seen it. */
export type ChatAnswerRow = {
	personaId: string;
	personaName: string;
	answer: LastAnswer;
	unread: boolean;
};

/**
 * The persona's last answer in each of the member's chats that has one, across the chat and its
 * threads, and whether it is unread; one query, and nothing made, for what is asked every so
 * often. Each thread's last answer is found on its own, from the newest entry back by the
 * `(threadId, seq)` index, so a long one is not read whole for it, and the chat's is the latest of
 * those: the entries' `seq` runs across every thread, as the read marker does.
 */
export async function listAnswers(
	orgId: string,
	userId: string,
): Promise<Result<ChatAnswerRow[], ApiError>> {
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
					SELECT last."id", last."seq", last."text"
					FROM "AgentThread" AS c
					CROSS JOIN LATERAL (
						SELECT "id", "seq", "text"
						FROM "AgentEntry"
						WHERE "threadId" = c."id" AND "kind" = 'assistant' AND "text" <> ''
						ORDER BY "seq" DESC
						LIMIT 1
					) AS last
					WHERE ${inChatSql(Prisma.sql`t."id"`, Prisma.raw('c'))}
					ORDER BY last."seq" DESC
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

/** Deletes a persona with every chat with it; `Ok(false)` means no such persona in the organization. */
export async function deletePersona(
	orgId: string,
	personaId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.persona.deleteMany({where: {id: personaId, orgId}}))).map(
		({count}) => count > 0,
	);
}

/** The member's chat with the persona; `Ok(null)` before they have one. */
export async function getMemberChat(
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
 * The member's chat with the persona, made where they have none yet, through the organization's
 * built-in login `agentId`: the one there is otherwise, two first openings at once making one,
 * since the persona's row is locked meanwhile.
 */
export async function ensureMemberChat(data: {
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

/** The persona's last answer in a chat, which the member may not have seen. */
export type LastAnswer = {id: string; text: string};

/**
 * Marks the chat read up to the entry, one of the chat's or of one of its threads, as far as the
 * member was shown it, never back: what the persona said after it stays unread. `Ok(false)` means
 * no such entry in the chat.
 */
export async function markChatRead(
	chatId: string,
	entryId: string,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(
			() =>
				db.$executeRaw`UPDATE "AgentThread" AS t SET "readSeq" = GREATEST(t."readSeq", e."seq") FROM "AgentEntry" AS e JOIN "AgentThread" AS c ON c."id" = e."threadId" WHERE t."id" = ${chatId} AND t."parentThreadId" IS NULL AND e."id" = ${entryId} AND ${inChatSql(Prisma.sql`t."id"`, Prisma.raw('c'))}`,
		)
	).map((count) => count > 0);
}

/** What the member typed in their chat and hasn't sent; `Ok(null)` for none, or no such chat. */
export async function getChatDraft(chatId: string): Promise<Result<string | null, ApiError>> {
	return (
		await wrapDb(() => db.agentThread.findUnique({where: {id: chatId}, select: {draft: true}}))
	).map((chat) => chat?.draft ?? null);
}

/**
 * A file in a chat's input, not sent yet: one of a drive's, by its connection, its id
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

// The files in a chat's input: its attachments with no entry yet.
function inInput(chatId: string) {
	return {threadId: chatId, entryId: null};
}

/** The files the member put in their chat's input and hasn't sent, in the order they sit there; none for no such chat. */
export function listDraftAttachments(chatId: string): Promise<Result<DraftAttachment[], ApiError>> {
	return wrapDb(() =>
		db.agentEntryAttachment.findMany({
			where: inInput(chatId),
			select: draftSelect,
			orderBy: {position: 'asc'},
		}),
	);
}

// The member's chat, locked for a change to its input or its threads; null for none, and for a
// thread, which keeps no input.
async function lockChat(tx: Tx, chatId: string): Promise<ThreadRow | null> {
	const chat = await lockThread(tx, chatId);
	return chat && chat.parentThreadId === null ? chat : null;
}

/**
 * Puts a file in the chat's input, after those there; one there already, at the same version, is
 * there once. A conflict where it holds `max` already. `Ok(false)` means no such chat.
 */
export function addDraftAttachment(
	chatId: string,
	attachment: DraftAttachment,
	max: number,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (!(await lockChat(tx, chatId))) {
				return false;
			}
			const kept = await tx.agentEntryAttachment.findMany({
				where: inInput(chatId),
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
				data: {...attachment, ...inInput(chatId), position},
				select: {id: true},
			});
			return true;
		}),
	);
}

/** Takes a file out of the chat's input; the file itself stays where it is kept. `Ok(false)` means no such chat. */
export function removeDraftAttachment(
	chatId: string,
	file: Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (!(await lockChat(tx, chatId))) {
				return false;
			}
			await tx.agentEntryAttachment.deleteMany({where: {...inInput(chatId), ...file}});
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
 * Keeps what the member typed in their chat and hasn't sent, in place of what was kept; null
 * forgets it. With `order`, the files in the input are kept in that order, as they sit among what
 * was typed, any it doesn't name after them; none are put there or taken out by it. `Ok(false)`
 * means no such chat: a thread keeps none.
 */
export async function saveChatDraft(
	chatId: string,
	draft: string | null,
	order?: Array<Pick<DraftAttachment, 'connectionId' | 'fileId' | 'version'>>,
): Promise<Result<boolean, ApiError>> {
	if (order === undefined) {
		return (
			await wrapDb(() =>
				db.agentThread.updateMany({where: {id: chatId, parentThreadId: null}, data: {draft}}),
			)
		).map(({count}) => count > 0);
	}
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			if (!(await lockChat(tx, chatId))) {
				return false;
			}
			await tx.agentThread.update({where: {id: chatId}, data: {draft}});
			const kept = await tx.agentEntryAttachment.findMany({
				where: inInput(chatId),
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
 * The thread's agent as it acts in the thread: signed in as the member whose chat it is of,
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

/** The harness and the model chosen for the thread's persona, as kept; `Ok(null)` where the persona is gone. */
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

/** The name of the thread's persona; `Ok(null)` where the persona is gone. */
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

/** A new task for a thread's calls, once the one before was finished while it was at work. */
export async function setThreadTask(
	threadId: string,
	taskId: string,
): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.agentThread.update({where: {id: threadId}, data: {taskId}}))).map(
		() => undefined,
	);
}

// Locks the chat the thread is part of, its own row or, a thread's, its chat's, for the rest of the
// transaction, and gives the thread as it is; null when there is no such thread.
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
// meanwhile included, so it is turn enough. Never for a chat, which runs no turns. With the thread
// locked.
async function queueInference(tx: Tx, thread: ThreadRow): Promise<void> {
	if (thread.parentThreadId === null) {
		return;
	}
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

// Answers a call of the thread's log, as its result, from the job that has the answer. With the
// thread locked.
async function answerCall(
	tx: Tx,
	thread: ThreadRow,
	answer: {callId: string; text: string; isError: boolean},
	jobId: string,
	wakes: Wakes,
): Promise<void> {
	await appendEntry(tx, thread, {kind: 'tool_result', ...answer, jobId}, wakes);
}

// Whether a message landed in the thread while its agent answered, pending, which it goes on to
// read. With the thread locked.
async function messageWaiting(tx: Tx, thread: ThreadRow): Promise<boolean> {
	const waiting = await tx.agentEntry.count({where: {threadId: thread.id, pending: true}});
	return waiting > 0;
}

// Finishes the thread's task, where it has one under way, with `outcome`. With the thread locked.
async function finishTask(tx: Tx, thread: ThreadRow, outcome: string): Promise<void> {
	if (thread.taskId === null) {
		return;
	}
	const now = new Date();
	await tx.agentTask.updateMany({
		where: {id: thread.taskId, finishedAt: null},
		data: {finishedAt: now, lastActiveAt: now, outcome},
	});
}

// A thread's answer without calls, which ends its turn: where a message came while it answered,
// it goes on to read it, its task still under way; otherwise its task is finished with the
// outcome, until a reply or an alert takes it up again (wakeWith). Nobody else is told. With the
// thread locked; what is pending is released after, as a job ends (endJob).
async function endTurn(tx: Tx, thread: ThreadRow, end: ThreadEnd): Promise<void> {
	if (await messageWaiting(tx, thread)) {
		return;
	}
	await finishTask(tx, thread, end.outcome);
}

/** A thread of a chat as the member's message opens it: its title and its task, as the api composes them from what they said. */
export type ThreadOpening = {title: string; task: NewAgentTask & {parentId: null}};

/**
 * Opens a thread in the member's chat with what they said, in one transaction: the thread, under
 * the chat, with its task, and their message as its first entry, with the files they attached,
 * which wakes its agent; what they had typed in the chat and not sent goes with it, since this is
 * it sent. `Ok(null)` means no such chat.
 */
export async function openThread(
	chatId: string,
	text: string,
	opening: ThreadOpening,
	wakes: Wakes,
	attachments: EntryAttachment[] = [],
): Promise<Result<{thread: ThreadRow; entry: EntryRow} | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const chat = await lockChat(tx, chatId);
			if (!chat) {
				return null;
			}
			await tx.agentThread.update({where: {id: chatId}, data: {draft: null}});
			await tx.agentEntryAttachment.deleteMany({where: inInput(chatId)});
			const now = new Date();
			const task = await tx.agentTask.create({
				data: {...opening.task, createdAt: now, lastActiveAt: now},
				select: {id: true},
			});
			const thread = toThread(
				await tx.agentThread.create({
					data: {
						orgId: chat.orgId,
						agentId: chat.agentId,
						personaId: chat.personaId,
						userId: chat.userId,
						parentThreadId: chat.id,
						title: opening.title,
						taskId: task.id,
					},
					select: threadSelect,
				}),
			);
			const entry = await appendEntry(tx, thread, {kind: 'person', text}, wakes);
			await attach(tx, thread.id, entry.id, attachments);
			return {thread, entry};
		}),
	);
}

/**
 * Lands what the member replied in one of their chat's threads, with the files they attached, and
 * wakes the thread's agent as wakeWith does, its task under way again. `Ok(null)` means no such
 * thread of the chat.
 */
export async function replyInThread(
	chatId: string,
	threadId: string,
	text: string,
	wakes: Wakes,
	attachments: EntryAttachment[] = [],
): Promise<Result<EntryRow | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const chat = await lockChat(tx, chatId);
			if (!chat) {
				return null;
			}
			const found = await tx.agentThread.findFirst({
				where: {id: threadId, parentThreadId: chat.id},
				select: threadSelect,
			});
			if (!found) {
				return null;
			}
			return wakeWith(tx, toThread(found), {kind: 'person', text}, wakes, attachments);
		}),
	);
}

/** One of a chat's threads, with what it is up to, the entries of it the member sees, and the files attached to them. */
export type ChatThreadRow = ThreadRow & {
	state: ThreadState;
	entries: EntryRow[];
	attachments: AttachmentRow[];
};

// An assistant entry with a call of the tool among its calls, as they are kept: as JSON, each
// call's name written as JSON.stringify writes it.
function withCall(tool: string): Prisma.AgentEntryWhereInput {
	return {kind: 'assistant', toolCalls: {contains: `"name":${JSON.stringify(tool)}`}};
}

// What of a thread the member sees in it: what they said, the events that came into it, what its
// agent answered in words, and its answers that made a call of one of `calls`, which the member
// sees as what the call said. Not the other calls, their results or the summaries.
function shownInThread(calls: string[]): Prisma.AgentEntryWhereInput {
	return {
		OR: [
			{kind: 'person'},
			{kind: 'event'},
			{kind: 'assistant', text: {not: ''}},
			...calls.map(withCall),
		],
	};
}

// The chat's threads `where` picks among them, oldest first, as ChatThreadRow has them.
async function readChatThreads(
	chatId: string,
	where: Prisma.AgentThreadWhereInput,
	calls: string[],
	now: Date,
): Promise<Result<ChatThreadRow[], ApiError>> {
	return wrapDb(async () => {
		const threads = await db.agentThread.findMany({
			where: {...where, parentThreadId: chatId},
			select: {
				...threadSelect,
				jobs: openJobsSelect,
				entries: {
					where: shownInThread(calls),
					select: entrySelect,
					orderBy: [{pending: 'asc'}, {seq: 'asc'}],
				},
			},
			orderBy: {createdAt: 'asc'},
		});
		const attachments = await attachmentsIn(threads.map((thread) => thread.id));
		return threads.map(({jobs, entries, ...thread}) => {
			const shown = new Set(entries.map((entry) => entry.id));
			return {
				...toThread(thread),
				state: threadState(jobs, now),
				entries: entries.map(toEntry),
				attachments: attachments.filter((attachment) => shown.has(attachment.entryId)),
			};
		});
	});
}

/**
 * The chat's threads, oldest first, each with what it is up to, the entries of it the member sees,
 * in order, what is pending last, the answers that made a call of one of `calls` among them, and
 * the files attached to them.
 */
export function listChatThreads(
	chatId: string,
	calls: string[],
	now = new Date(),
): Promise<Result<ChatThreadRow[], ApiError>> {
	return readChatThreads(chatId, {}, calls, now);
}

/** One of the chat's threads, as listChatThreads has it; `Ok(null)` for no such thread of the chat. */
export async function getChatThread(
	chatId: string,
	threadId: string,
	calls: string[],
	now = new Date(),
): Promise<Result<ChatThreadRow | null, ApiError>> {
	return (await readChatThreads(chatId, {id: threadId}, calls, now)).map(
		(threads) => threads[0] ?? null,
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
	return wrapDb(() => attachmentsIn([threadId]));
}

// The files of the threads' logs, as listAttachments has them.
async function attachmentsIn(threadIds: string[]): Promise<AttachmentRow[]> {
	if (threadIds.length === 0) {
		return [];
	}
	const rows = await db.agentEntryAttachment.findMany({
		where: {threadId: {in: threadIds}, entryId: {not: null}},
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
}

/**
 * Whether the person attached the version of the file in the thread whose task it is. False for a
 * task that is no thread's. A file the agent showed them hands nothing over: the agent could read
 * it already.
 */
export async function isAttachedForTask(
	task: {orgId: string; taskId: string},
	file: {connectionId: string; fileId: string; version: string},
): Promise<Result<boolean, ApiError>> {
	return wrapDb(async () => {
		const thread = await db.agentThread.findFirst({where: task, select: {id: true}});
		if (!thread) {
			return false;
		}
		const found = await db.agentEntryAttachment.findFirst({
			where: {
				threadId: thread.id,
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

// Ends the worker's job on its thread: locks its chat, marks the job `status` (fence),
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
 * it was, in its thread, locked, so the thread goes on. `Ok(false)` when the job was no longer the
 * worker's, and nothing is written.
 */
export async function failJob(
	jobId: string,
	workerId: string,
	error: string,
	noteFor: (job: JobRow) => FailureNote | null,
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
				const note = noteFor(job);
				if (note) {
					await writeNote(tx, thread, note, job.id, wakes);
				}
			});
		}),
	);
}

// Writes what a failed job leaves in its thread. A turn that failed is answered with the failure,
// so the log is not left ready for the model again. With the thread locked; what is pending is
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
			{callId: note.callId, text: note.text, isError: true},
			jobId,
			wakes,
		);
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
	await endTurn(tx, thread, note.end);
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
 * Runs `write` with the job's chat locked, where the job is still the worker's and its
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
 * Lands what wakes a thread's agent, the member's reply or an alert's event, with the files it
 * goes with, and wakes it: one that had stopped takes it up, its task under way again
 * (takeUpTask); one at work reads it once its current call is answered; and one asleep is woken
 * now, its sleep's job due now, which answers the sleep as any wake-up does, the message after it,
 * or its wake-up due now, which reads the message. With the thread locked.
 */
export async function wakeWith(
	tx: Tx,
	thread: ThreadRow,
	entry: NewEntry,
	wakes: Wakes,
	attachments: EntryAttachment[] = [],
	now = new Date(),
): Promise<EntryRow> {
	if (thread.taskId !== null) {
		await takeUpTask(tx, {...thread, taskId: thread.taskId}, now);
	}
	// Only a sleep's job, the sleep's own or the wake-up that answers it, is due later; one a worker
	// has claimed is no longer queued, and answers as it would.
	await tx.agentJob.updateMany({
		where: {threadId: thread.id, kind: {in: ['tool', 'wake']}, status: 'queued', runAt: {gt: now}},
		data: {runAt: now},
	});
	const appended = await appendEntry(tx, thread, entry, wakes);
	await attach(tx, thread.id, appended.id, attachments);
	return appended;
}

// Puts the thread's task under way again from `now`, as a reply or an alert wakes it. One that
// ended, finished or left open, more than 20 minutes before stays as it was, and a new one for the
// same work takes its place, so a task long over isn't drawn as under way again
// (@proxy/utils/tasks). With the thread locked.
async function takeUpTask(tx: Tx, thread: ThreadRow & {taskId: string}, now: Date): Promise<void> {
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

/**
 * Finishes an inference job, or a wake job, with the model's answer: the assistant entry, then
 * what follows it, each of its calls as its plan says, a tool job due when it says or an answer at
 * once (`CallPlan`); or, an answer without calls, the end of the thread's turn, its task finished
 * where nothing came meanwhile. A call without a plan gets a tool job due now.
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
				if ('end' in after) {
					await endTurn(tx, thread, after.end);
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
					await tx.agentEntry.create({
						data: {
							threadId,
							kind: 'tool_result' satisfies AgentEntryKind,
							callId: call.id,
							jobId,
							text: plan.text,
							isError: plan.isError,
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
				answerCall(tx, thread, result, jobId, wakes),
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
