import {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {
	appendEntry,
	endJob,
	type InlineJob,
	lockThread,
	type PersonaRow,
	personaSelect,
	type ThreadRow,
	toPersona,
	type Wakes,
	writeInline,
} from './harness';

/**
 * The built-in agent's alerts (AgentAlert) and the polls their watches read (ConnectionPoll). An
 * alert is set in the transaction that answers the call that set it, so a tool job run again sets
 * nothing more; where the harness runs the call itself, mid-turn, it is set on its own, fenced by
 * the turn's job (setAlertInline); a watch's polls are made with it, and kept. Both are taken by the alerts' sweep,
 * each moved on as it is taken, so one api instance takes each, and what each comes to is written
 * in one transaction: a timed alert lands as it is deleted, and a poll's look lands what matched,
 * for every watch on it, as it moves the cursor on from where the look started. A turn that fails,
 * is cut short, or was taken over by another instance writes nothing, and comes again from where
 * it was. An alert is deleted when it fires, when the agent cancels it, or when the person deletes
 * it on the Alerts page; a poll goes with its connection.
 */

export type AlertRow = {
	id: string;
	orgId: string;
	userId: string;
	// The conversation it was set in, where what it comes to lands.
	threadId: string;
	title: string;
	brief: string;
	// A timed alert's time; null for a watch.
	at: Date | null;
	// A watch: the collection watched, the connections watched, and the words any of which a record
	// has to carry; null, none and none for a timed alert.
	collectionId: string | null;
	connectionIds: string[];
	terms: string[];
	// When a watch last matched a record; null before the first match, and for a timed alert.
	lastMatchedAt: Date | null;
	createdAt: Date;
};

/** An alert to set: at a time, or a watch on a collection of some connections. */
export type NewAlert = {title: string; brief: string} & (
	| {kind: 'time'; at: Date}
	| {kind: 'watch'; collectionId: string; connectionIds: string[]; terms: string[]}
);

/** Where a connection's collection was last looked at: `cursor` null before the first look. */
export type PollRow = {connectionId: string; collectionId: string; cursor: string | null};

/** What a look tells a watch that matched: the text that lands in its conversation. */
export type WatchMatch = {alert: AlertRow; text: string};

const alertSelect = {
	id: true,
	orgId: true,
	userId: true,
	threadId: true,
	title: true,
	brief: true,
	at: true,
	collectionId: true,
	connectionIds: true,
	terms: true,
	lastMatchedAt: true,
	createdAt: true,
} as const satisfies Prisma.AgentAlertSelect;

// Sets the alert in the conversation: a timed one due at its time, or a watch with the polls of
// its connections, made where there are none yet. With the conversation locked.
async function createAlert(
	tx: Prisma.TransactionClient,
	thread: ThreadRow,
	alert: NewAlert,
): Promise<AlertRow> {
	const made = await tx.agentAlert.create({
		data: {
			orgId: thread.orgId,
			userId: thread.userId,
			threadId: thread.id,
			title: alert.title,
			brief: alert.brief,
			...(alert.kind === 'time'
				? {at: alert.at, nextAt: alert.at}
				: {
						collectionId: alert.collectionId,
						connectionIds: alert.connectionIds,
						terms: alert.terms,
					}),
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
 * Finishes the tool job of a set_alert call: sets the alert in the conversation, a timed one due
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

/** The alerts set in the conversation, oldest first: what the agent is told it has. */
export async function listThreadAlerts(threadId: string): Promise<Result<AlertRow[], ApiError>> {
	return wrapDb(() =>
		db.agentAlert.findMany({where: {threadId}, select: alertSelect, orderBy: {createdAt: 'asc'}}),
	);
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

/** The member's alerts in the organization, newest first, each with the persona it was set with. */
export async function listMemberAlerts(
	orgId: string,
	userId: string,
): Promise<Result<Array<AlertRow & {persona: PersonaRow}>, ApiError>> {
	return (
		await wrapDb(() =>
			db.agentAlert.findMany({
				where: {orgId, userId},
				select: {...alertSelect, thread: {select: {persona: {select: personaSelect}}}},
				orderBy: {createdAt: 'desc'},
			}),
		)
	).map((alerts) =>
		alerts.map(({thread, ...alert}) => ({...alert, persona: toPersona(thread.persona)})),
	);
}

/**
 * Deletes an alert: the conversation's, as the agent cancels one, or the member's, as the Alerts
 * page deletes one. `Ok(false)` when there is none such.
 */
export async function deleteAlert(
	alertId: string,
	owner: {threadId: string} | {orgId: string; userId: string},
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.agentAlert.deleteMany({where: {id: alertId, ...owner}}))).map(
		({count}) => count > 0,
	);
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

/**
 * Fires a timed alert: what `text` says lands in its conversation as an event, and the alert is
 * deleted, in one transaction. Wakes the agent where the log then `wakes` it. `Ok(false)` when
 * the alert or its conversation is gone, and nothing is written.
 */
export async function fireAlert(
	alert: AlertRow,
	text: string,
	wakes: Wakes,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const thread = await lockThread(tx, alert.threadId);
			if (!thread) {
				return false;
			}
			const {count} = await tx.agentAlert.deleteMany({where: {id: alert.id}});
			if (count === 0) {
				return false;
			}
			await appendEntry(tx, thread, {kind: 'event', text}, wakes);
			return true;
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
 * Notes a look at a poll: where it left off, `cursor`, and what it matched, which lands in each
 * matching watch's conversation as an event, in one transaction, only from where the look started,
 * the cursor the poll was taken with. A watch deleted since is told nothing. The conversations are
 * locked in the order of their ids, so two looks never wait on each other in a circle. Wakes each agent where
 * its log then `wakes` it. `Ok(false)` when the poll was looked at from there since, or is gone,
 * and nothing is written.
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
			// The conversations first, then the poll, as a watch set takes its conversation, then its polls.
			const threads = new Map<string, ThreadRow | null>();
			for (const threadId of [...new Set(matched.map(({alert}) => alert.threadId))].sort()) {
				threads.set(threadId, await lockThread(tx, threadId));
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
			for (const {alert, text} of matched) {
				const thread = threads.get(alert.threadId);
				if (!thread) {
					continue;
				}
				const marked = await tx.agentAlert.updateMany({
					where: {id: alert.id},
					data: {lastMatchedAt: at},
				});
				if (marked.count === 0) {
					continue;
				}
				await appendEntry(tx, thread, {kind: 'event', text}, wakes);
			}
			return true;
		}),
	);
}
