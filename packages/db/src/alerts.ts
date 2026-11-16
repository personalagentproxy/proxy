import {type AlertSplit, Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {
	appendEntry,
	endJob,
	type InlineJob,
	lockChat,
	lockThread,
	openThreadIn,
	type PersonaRow,
	personaSelect,
	type ThreadOpening,
	type ThreadRow,
	toPersona,
	type Wakes,
	wakeWith,
	writeInline,
} from './harness';

export type {AlertSplit} from '@prisma/client';

/**
 * The built-in agent's alerts (AgentAlert) and the polls their watches read (ConnectionPoll). An
 * alert is set in the transaction that answers the call that set it, so a tool job run again sets
 * nothing more; where the harness runs the call itself, mid-turn, it is set on its own, fenced by
 * the turn's job (setAlertInline); a watch's polls are made with it, and kept. Both are taken by the alerts' sweep,
 * each moved on as it is taken, so one api instance takes each, and what each comes to is written
 * in one transaction: a timed alert lands as it is deleted, or moved on to its next time where it
 * repeats, and a poll's look lands what matched, for every watch on it, as it moves the cursor on
 * from where the look started. What lands goes into the thread the alert comes to, waking it, or,
 * for one that opens new threads, into a new thread of the chat (`Landing`). A turn that fails, is
 * cut short, or was taken over by another instance writes nothing, and comes again from where it
 * was. An alert is deleted when it fires once and for all, when the agent cancels it, when the
 * person deletes it on the Alerts page, or cancels those of a thread as they mark it done or
 * archive it; a poll goes with its connection.
 */

export type AlertRow = {
	id: string;
	orgId: string;
	userId: string;
	// The member's chat it was set in a thread of.
	chatId: string;
	// The thread it comes to, where what it comes to lands; null for one that opens a new thread
	// in the chat each time.
	threadId: string | null;
	// The thread it was set in; null once that is gone.
	setInThreadId: string | null;
	title: string;
	brief: string;
	// A timed alert's time, the first where it repeats; null for a watch.
	at: Date | null;
	// When it is next due, a timed alert's; null for a watch.
	nextAt: Date | null;
	// How a timed alert repeats, an RRULE, read in `timeZone`; null for one that comes once.
	every: string | null;
	timeZone: string | null;
	// A watch: the collection watched, the connections watched, and the words any of which a record
	// has to carry; null, none and none for a timed alert.
	collectionId: string | null;
	connectionIds: string[];
	terms: string[];
	// How a watch that opens new threads splits what a look found; null otherwise.
	split: AlertSplit | null;
	// When a watch last matched a record; null before the first match, and for a timed alert.
	lastMatchedAt: Date | null;
	createdAt: Date;
};

/** Where an alert comes: into the thread it is set in, or into the chat, as a new thread each time. */
export type AlertOpens = 'this_thread' | 'new_thread';

/**
 * An alert to set: at a time, repeating by an RRULE in a time zone where it opens new threads, or
 * a watch on a collection of some connections, split as it says where it opens new threads.
 */
export type NewAlert = {title: string; brief: string} & (
	| {kind: 'time'; opens: 'this_thread'; at: Date}
	| {kind: 'time'; opens: 'new_thread'; at: Date; every: {rule: string; timeZone: string} | null}
	| {
			kind: 'watch';
			opens: 'this_thread';
			collectionId: string;
			connectionIds: string[];
			terms: string[];
	  }
	| {
			kind: 'watch';
			opens: 'new_thread';
			collectionId: string;
			connectionIds: string[];
			terms: string[];
			split: AlertSplit;
	  }
);

/** Where a connection's collection was last looked at: `cursor` null before the first look. */
export type PollRow = {connectionId: string; collectionId: string; cursor: string | null};

/**
 * What an alert comes to, once: the text that lands as an event, and, for one that opens new
 * threads, the thread it opens in the chat, as the api composes it; null for one that comes to its
 * thread.
 */
export type Landing = {text: string; opening: ThreadOpening | null};

/** What a look tells a watch that matched: what lands, one for each thread it opens, or one for its thread. */
export type WatchMatch = {alert: AlertRow; landings: Landing[]};

const alertSelect = {
	id: true,
	orgId: true,
	userId: true,
	chatId: true,
	threadId: true,
	setInThreadId: true,
	title: true,
	brief: true,
	at: true,
	nextAt: true,
	every: true,
	timeZone: true,
	collectionId: true,
	connectionIds: true,
	terms: true,
	split: true,
	lastMatchedAt: true,
	createdAt: true,
} as const satisfies Prisma.AgentAlertSelect;

// What of an alert to set is kept for when it comes: a timed one's times and how it repeats, or a
// watch's rule and how it splits.
function whenData(alert: NewAlert): Partial<Prisma.AgentAlertUncheckedCreateInput> {
	if (alert.kind === 'time') {
		const every = alert.opens === 'new_thread' ? alert.every : null;
		return {
			at: alert.at,
			nextAt: alert.at,
			every: every?.rule ?? null,
			timeZone: every?.timeZone ?? null,
		};
	}
	return {
		collectionId: alert.collectionId,
		connectionIds: alert.connectionIds,
		terms: alert.terms,
		split: alert.opens === 'new_thread' ? alert.split : null,
	};
}

// Sets the alert in the thread, coming to it or to its chat: a timed one due at its time, or a
// watch with the polls of its connections, made where there are none yet. With the thread locked.
async function createAlert(
	tx: Prisma.TransactionClient,
	thread: ThreadRow,
	alert: NewAlert,
): Promise<AlertRow> {
	const made = await tx.agentAlert.create({
		data: {
			orgId: thread.orgId,
			userId: thread.userId,
			chatId: thread.parentThreadId ?? thread.id,
			threadId: alert.opens === 'this_thread' ? thread.id : null,
			setInThreadId: thread.id,
			title: alert.title,
			brief: alert.brief,
			...whenData(alert),
		},
		select: alertSelect,
	});
	if (alert.kind === 'watch') {
		for (const connectionId of alert.connectionIds) {
			await tx.connectionPoll.upsert({
				where: {connectionId_collectionId: {connectionId, collectionId: alert.collectionId}},
				create: {connectionId, collectionId: alert.collectionId},
				update: {},
			});
		}
	}
	return made;
}

/**
 * Finishes the tool job of a set_alert call: sets the alert in the thread, a timed one due
 * at its time and a watch with the polls of its connections, and answers the call as `answer`
 * says of it, in one transaction. Wakes the agent where the log then `wakes` it. `Ok(false)` when
 * the job was no longer the worker's, and nothing is set.
 */
export async function completeSetAlert(
	job: {jobId: string; workerId: string; threadId: string; callId: string},
	alert: NewAlert,
	answer: (alert: AlertRow) => string,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction((tx) =>
			endJob(tx, {...job, status: 'done'}, wakes, async (thread) => {
				const made = await createAlert(tx, thread, alert);
				await appendEntry(
					tx,
					thread,
					{
						kind: 'tool_result',
						callId: job.callId,
						text: answer(made),
						isError: false,
						jobId: job.jobId,
					},
					wakes,
				);
			}),
		),
	);
}

/**
 * Sets the alert of a set_alert call from the inference job that runs the turn, where the harness
 * runs the call itself: the alert alone, in its own transaction; the call's answer is the turn's
 * to write (appendTurnEntries), and the job goes on. The alert set: `Ok(null)` when the job was no
 * longer the worker's, or its thread is gone, and nothing is set.
 */
export async function setAlertInline(
	job: InlineJob,
	alert: NewAlert,
): Promise<Result<AlertRow | null, ApiError>> {
	return writeInline(job, null, (tx, thread) => createAlert(tx, thread, alert));
}

/** The watches on the connection's collection. */
export async function listWatches(
	connectionId: string,
	collectionId: string,
): Promise<Result<AlertRow[], ApiError>> {
	return wrapDb(() =>
		db.agentAlert.findMany({
			where: {collectionId, connectionIds: {has: connectionId}},
			select: alertSelect,
			orderBy: {createdAt: 'asc'},
		}),
	);
}

/** A thread an alert comes to, or was set in, by its id and title. */
export type ThreadRef = {id: string; title: string};

/**
 * One of a member's alerts, with the persona it was set with, the thread it comes to, null for one
 * that opens a new thread each time, and the thread it was set in, null once that is gone.
 */
export type MemberAlertRow = AlertRow & {
	persona: PersonaRow;
	thread: ThreadRef | null;
	setIn: ThreadRef | null;
};

const threadRefSelect = {select: {id: true, title: true}} as const;

function toThreadRef(thread: {id: string; title: string | null} | null): ThreadRef | null {
	return thread === null ? null : {id: thread.id, title: thread.title ?? ''};
}

/** The member's alerts in the organization, newest first, each with the persona it was set with and its threads. */
export async function listMemberAlerts(
	orgId: string,
	userId: string,
): Promise<Result<MemberAlertRow[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentAlert.findMany({
				where: {orgId, userId},
				select: {
					...alertSelect,
					chat: {select: {persona: {select: personaSelect}}},
					thread: threadRefSelect,
					setIn: threadRefSelect,
				},
				orderBy: {createdAt: 'desc'},
			}),
		)
	).map((alerts) =>
		alerts.map(({chat, thread, setIn, ...alert}) => ({
			...alert,
			persona: toPersona(chat.persona),
			thread: toThreadRef(thread),
			setIn: toThreadRef(setIn),
		})),
	);
}

/**
 * Deletes one of the member's alerts, whichever of their threads it was set in: as a thread's
 * agent cancels one, as the Alerts page deletes one, and as their Chat connection does.
 * `Ok(false)` when there is none such.
 */
export async function deleteAlert(
	alertId: string,
	owner: {orgId: string; userId: string},
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.agentAlert.deleteMany({where: {id: alertId, ...owner}}))).map(
		({count}) => count > 0,
	);
}

/** How many of the chat's alerts open a new thread in it each time, rather than come to one of its threads. */
export async function countChatAlerts(chatId: string): Promise<Result<number, ApiError>> {
	return wrapDb(() => db.agentAlert.count({where: {chatId, threadId: null}}));
}

// Prisma writes a DateTime as the UTC wall clock, in a column without a time zone; now() has one,
// and would be read in the server's, so its UTC wall clock is what is compared and written.

/**
 * Up to `limit` of the timed alerts due, each moved on by `everyMs` as it is taken, so that one
 * api instance takes each and one whose turn fails comes again then.
 */
export async function claimDueAlerts(
	everyMs: number,
	limit: number,
): Promise<Result<AlertRow[], ApiError>> {
	const claimed = await wrapDb(
		() => db.$queryRaw<Array<{id: string}>>`
			UPDATE "AgentAlert" SET "nextAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${everyMs / 1000})
			WHERE "id" IN (
				SELECT "id" FROM "AgentAlert"
				WHERE "nextAt" <= now() AT TIME ZONE 'UTC'
				ORDER BY "nextAt"
				LIMIT ${limit}
				FOR UPDATE SKIP LOCKED
			)
			RETURNING "id"`,
	);
	if (claimed.isErr() || claimed.value.length === 0) {
		return claimed.map(() => []);
	}
	const ids = claimed.value.map(({id}) => id);
	return wrapDb(() =>
		db.agentAlert.findMany({where: {id: {in: ids}}, select: alertSelect, orderBy: {at: 'asc'}}),
	);
}

// Lands what an alert comes to, with its chat locked: into the thread it comes to, as an event
// that wakes it (wakeWith), or, for one that opens new threads, as the first entry of a thread it
// opens in the chat, which wakes that thread's agent. False where the thread or the chat is gone,
// or the alert opens new threads and nothing says how.
async function land(
	tx: Prisma.TransactionClient,
	alert: AlertRow,
	landing: Landing,
	wakes: Wakes,
): Promise<boolean> {
	if (alert.threadId !== null) {
		const thread = await lockThread(tx, alert.threadId);
		if (!thread) {
			return false;
		}
		await wakeWith(tx, thread, {kind: 'event', text: landing.text}, wakes);
		return true;
	}
	const chat = await lockChat(tx, alert.chatId);
	if (!chat || landing.opening === null) {
		return false;
	}
	const thread = await openThreadIn(tx, chat, landing.opening, true);
	await appendEntry(tx, thread, {kind: 'event', text: landing.text}, wakes);
	return true;
}

/**
 * Fires a timed alert: what it comes to lands (`Landing`), in its thread or a new one of its chat,
 * and the alert is deleted, or, one that repeats, due again at `next`, in one transaction; deleted
 * where it comes no more, `next` null. Wakes the agent as a reply would: a thread asleep is woken
 * now, and its task taken up again. `Ok(false)` when the alert or where it lands is gone, and
 * nothing is written.
 */
export async function fireAlert(
	alert: AlertRow,
	landing: Landing,
	next: Date | null,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			// The chat first, as everything that writes in it locks it.
			if (!(await lockChat(tx, alert.chatId))) {
				return false;
			}
			const {count} =
				next === null
					? await tx.agentAlert.deleteMany({where: {id: alert.id}})
					: await tx.agentAlert.updateMany({where: {id: alert.id}, data: {nextAt: next}});
			if (count === 0) {
				return false;
			}
			return land(tx, alert, landing, wakes);
		}),
	);
}

/**
 * Up to `limit` of the polls due that a watch is on, each moved on by `everyMs` as it is taken,
 * so that one api instance takes each and one whose look fails comes again then. A poll due that
 * no watch is on has its cursor cleared, and is taken no more until a watch is set on it, whose
 * first look starts from then.
 */
export async function claimDuePolls(
	everyMs: number,
	limit: number,
): Promise<Result<PollRow[], ApiError>> {
	// Whether a watch is on the poll `q`.
	const watched = Prisma.sql`EXISTS (
		SELECT 1 FROM "AgentAlert" a
		WHERE a."collectionId" = q."collectionId" AND q."connectionId" = ANY (a."connectionIds")
	)`;
	return (
		await wrapDb(
			() => db.$queryRaw<Array<PollRow & {watched: boolean}>>`
				UPDATE "ConnectionPoll" AS p
				SET "nextAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${everyMs / 1000}),
					"cursor" = CASE WHEN due."watched" THEN p."cursor" ELSE NULL END
				FROM (
					SELECT q."connectionId", q."collectionId", ${watched} AS "watched"
					FROM "ConnectionPoll" q
					WHERE q."nextAt" <= now() AT TIME ZONE 'UTC' AND (q."cursor" IS NOT NULL OR ${watched})
					ORDER BY q."nextAt"
					LIMIT ${limit}
					FOR UPDATE OF q SKIP LOCKED
				) AS due
				WHERE p."connectionId" = due."connectionId" AND p."collectionId" = due."collectionId"
				RETURNING p."connectionId", p."collectionId", p."cursor", due."watched"`,
		)
	).map((polls) => polls.flatMap(({watched, ...poll}) => (watched ? [poll] : [])));
}

/**
 * Notes a look at a poll: where it left off, `cursor`, and what it matched, which lands for each
 * matching watch, in its thread or in new ones of its chat, in one transaction, only from where the
 * look started, the cursor the poll was taken with. A watch deleted since is told nothing. The
 * chats are locked in the order of their ids, so two looks never wait on each other in a circle.
 * Wakes each agent where its log then `wakes` it. `Ok(false)` when the poll was looked at from
 * there since, or is gone, and nothing is written.
 */
export async function recordLook(
	poll: PollRow,
	cursor: string,
	matched: WatchMatch[],
	at: Date,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			// The chats first, then the poll, as a watch set takes its thread's chat, then its polls.
			const chats = [...new Set(matched.map(({alert}) => alert.chatId))].toSorted();
			const present = new Set<string>();
			for (const chatId of chats) {
				if (await lockChat(tx, chatId)) {
					present.add(chatId);
				}
			}
			const {count} = await tx.connectionPoll.updateMany({
				where: {
					connectionId: poll.connectionId,
					collectionId: poll.collectionId,
					cursor: poll.cursor,
				},
				data: {cursor},
			});
			if (count === 0) {
				return false;
			}
			for (const {alert, landings} of matched) {
				if (!present.has(alert.chatId)) {
					continue;
				}
				const marked = await tx.agentAlert.updateMany({
					where: {id: alert.id},
					data: {lastMatchedAt: at},
				});
				if (marked.count === 0) {
					continue;
				}
				for (const landing of landings) {
					await land(tx, alert, landing, wakes);
				}
			}
			return true;
		}),
	);
}
