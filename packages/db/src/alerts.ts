import type {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {type PersonaRow, personaSelect, toPersona} from './harness';

/**
 * The built-in agent's alerts (AgentAlert): set in a member's conversation by a call of the agent's,
 * once per call; a timed one with its job, due at its time, which fires it (harness.ts fireAlert);
 * a watch with the polls of the connections it watches (ConnectionPoll), each due now where it is
 * new. An alert is deleted when it fires, when the agent cancels it, or when the person deletes it
 * on the Alerts page; a timed one's job goes with it. A poll is claimed by moving its due time on,
 * so one api instance takes each, and deleted by the look that finds no watch on it.
 */

export type AlertRow = {
	id: string;
	orgId: string;
	userId: string;
	// The conversation it was set in, where what it comes to lands.
	threadId: string;
	callId: string;
	title: string;
	brief: string;
	// A timed alert's time; null for a watch.
	at: Date | null;
	// A watch: the collection watched, the connections watched, and the words any of which a record
	// has to carry; null, none and none for a timed alert.
	collectionId: string | null;
	connectionIds: string[];
	terms: string[];
	createdAt: Date;
};

/** An alert to set: at a time, or a watch on a collection of some connections. */
export type NewAlert = {title: string; brief: string} & (
	| {kind: 'time'; at: Date}
	| {kind: 'watch'; collectionId: string; connectionIds: string[]; terms: string[]}
);

/** Where a connection's collection was last looked at: `cursor` null before the first look. */
export type PollRow = {connectionId: string; collectionId: string; cursor: string | null};

const alertSelect = {
	id: true,
	orgId: true,
	userId: true,
	threadId: true,
	callId: true,
	title: true,
	brief: true,
	at: true,
	collectionId: true,
	connectionIds: true,
	terms: true,
	createdAt: true,
} as const satisfies Prisma.AgentAlertSelect;

/**
 * Sets an alert in the conversation, from the call that set it: a timed one with its job, a watch
 * with the polls of its connections. The same call again, a tool job run again, gives the alert
 * it set.
 */
export async function createAlert(
	thread: {id: string; orgId: string; userId: string},
	callId: string,
	alert: NewAlert,
): Promise<Result<AlertRow, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const existing = await tx.agentAlert.findUnique({
				where: {threadId_callId: {threadId: thread.id, callId}},
				select: alertSelect,
			});
			if (existing) {
				return existing;
			}
			const made = await tx.agentAlert.create({
				data: {
					orgId: thread.orgId,
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
								terms: alert.terms,
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
					create: {connectionId, collectionId: alert.collectionId},
					update: {},
				});
			}
			return made;
		}),
	);
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
 * Deletes an alert, with a timed one's job still queued: the conversation's, as the agent cancels
 * one, or the member's, as the Alerts page deletes one. `Ok(false)` when there is none such.
 */
export async function deleteAlert(
	alertId: string,
	owner: {threadId: string} | {orgId: string; userId: string},
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const {count} = await tx.agentAlert.deleteMany({where: {id: alertId, ...owner}});
			if (count === 0) {
				return false;
			}
			await tx.agentJob.deleteMany({where: {alertId, status: 'queued'}});
			return true;
		}),
	);
}

/**
 * The polls due, each moved on by `everyMs` as it is taken, so that one api instance takes each
 * and a look that fails comes again then.
 */
export async function claimDuePolls(everyMs: number): Promise<Result<PollRow[], ApiError>> {
	// Prisma writes a DateTime as the UTC wall clock, in a column without a time zone; now() has
	// one, and would be read in the server's, so its UTC wall clock is what is compared and
	// written.
	return wrapDb(
		() => db.$queryRaw<PollRow[]>`
			UPDATE "ConnectionPoll" SET "nextAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${everyMs / 1000})
			WHERE ("connectionId", "collectionId") IN (
				SELECT "connectionId", "collectionId" FROM "ConnectionPoll"
				WHERE "nextAt" <= now() AT TIME ZONE 'UTC'
				FOR UPDATE SKIP LOCKED
			)
			RETURNING "connectionId", "collectionId", "cursor"`,
	);
}

/** Where a look left off, for the next to start from. */
export async function setPollCursor(
	poll: PollRow,
	cursor: string,
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.connectionPoll.updateMany({
				where: {connectionId: poll.connectionId, collectionId: poll.collectionId},
				data: {cursor},
			}),
		)
	).map(() => undefined);
}

/** Deletes a poll, once no watch is on it, or its connection no longer polls. */
export async function deletePoll(poll: PollRow): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.connectionPoll.deleteMany({
				where: {connectionId: poll.connectionId, collectionId: poll.collectionId},
			}),
		)
	).map(() => undefined);
}
