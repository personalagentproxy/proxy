import type {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * Polling: one collection of one connection, looked at every so often for what is new or changed
 * since the last look, while anything wants it looked at. A poll's row is where the last look
 * left off, in the connector's own terms (`cursor`; null before the first look, which only takes
 * a baseline), and when the next is due. A poll is claimed by one api instance at a time with a
 * lease, as the built-in agent's jobs are, and finished with where it left off, which is written
 * after whoever wanted the look has taken what it found: a look is delivered at least once, and
 * what takes it has to take the same records twice without harm. What is done with a look is the
 * api's to say (its polling); nothing here knows who wanted it.
 */

export type PollRow = {
	id: string;
	orgId: string;
	connectionId: string;
	collectionId: string;
	cursor: string | null;
	nextAt: Date;
	claimedBy: string | null;
	lastPolledAt: Date | null;
	// What the last look failed with; null once one went through.
	lastError: string | null;
};

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
} as const satisfies Prisma.ConnectionPollSelect;

/** Has the connection's collection polled, from now on; the poll there is already, otherwise, as it is. */
export async function ensurePoll(data: {
	orgId: string;
	connectionId: string;
	collectionId: string;
}): Promise<Result<PollRow, ApiError>> {
	const {connectionId, collectionId} = data;
	return wrapDb(() =>
		db.connectionPoll.upsert({
			where: {connectionId_collectionId: {connectionId, collectionId}},
			create: data,
			update: {},
			select: pollSelect,
		}),
	);
}

/** The organization's polls: what each connection's collection was last looked at, and with what error. */
export async function listPolls(orgId: string): Promise<Result<PollRow[], ApiError>> {
	return wrapDb(() => db.connectionPoll.findMany({where: {orgId}, select: pollSelect}));
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
	// Prisma writes a DateTime as the UTC wall clock, in a column without a time zone; now() has
	// one, and would be read in the server's, so its UTC wall clock is what is compared and
	// written.
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

/**
 * Finishes the worker's poll: where the look left off, when the next is due, and what it failed
 * with, if it did. `Ok(false)` when the poll was no longer the worker's.
 */
export async function finishPoll(
	pollId: string,
	workerId: string,
	outcome: {cursor: string | null; nextAt: Date; error: string | null},
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.connectionPoll.updateMany({
				where: {id: pollId, claimedBy: workerId},
				data: {
					cursor: outcome.cursor,
					nextAt: outcome.nextAt,
					lastPolledAt: new Date(),
					lastError: outcome.error,
					claimedBy: null,
					leaseExpiresAt: null,
				},
			}),
		)
	).map(({count}) => count > 0);
}

/** Deletes a poll, once nothing wants the look any more, or its connection is gone. */
export async function deletePoll(pollId: string): Promise<Result<void, ApiError>> {
	return (await wrapDb(() => db.connectionPoll.deleteMany({where: {id: pollId}}))).map(
		() => undefined,
	);
}
