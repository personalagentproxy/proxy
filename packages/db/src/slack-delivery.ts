import type {AgentEntryKind} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {type ShownEntryRow, toToolCalls, withPassedOn} from './harness';
import {type SlackSessionPlace, sessionPlaceSelect, toSessionPlace} from './slack-sessions';

/**
 * What a thread that lives in Slack has said, delivered there: each place keeps how far it is
 * delivered (`deliveredSeq`, and of the entry `partSeq` its first `partsPosted` messages), and the
 * delivery sweep, in each api instance, takes the places with anything past that, moving each on
 * as it takes it, as the alerts' sweep does, and names itself on it (`claimedBy`), so that only it
 * moves the mark until it lets the place go or its hold runs out.
 *
 * The mark never skips an entry. An entry's `seq` is drawn as it is written, not as its
 * transaction commits, so in the whole table a later `seq` can be seen before an earlier one; but
 * every write in a thread is made with its chat's row locked first (`lockThread` in harness.ts),
 * and the `seq` drawn after, so of one thread's entries a later `seq` is only drawn once the
 * transaction that wrote an earlier one has committed. One statement reading a thread's entries
 * therefore never sees one of them without every earlier one; the mark moves only to entries read
 * so (`readSlackUndelivered`). What is pending, as the member's reply while a turn runs, isn't
 * read; it is given a new `seq` as it is released, under the same lock, so it comes after the mark.
 *
 * The sweep also keeps each place's Slack agent session showing where its thread stands
 * (slack-sessions.ts), so it takes a place too where that may have changed since it was last set.
 */

/** A place the sweep took: where it is in Slack, how far it is delivered, what says whether to deliver to it, and its session. */
export type SlackDelivery = SlackSessionPlace & {
	deliveredSeq: number;
	partSeq: number | null;
	partsPosted: number;
	attempts: number;
	thread: {orgId: string; userId: string};
	org: {experiments: string[]; insider: boolean};
	// Whether the thread's member is still linked to a Slack user in the app's workspace, and still in the organization.
	member: {linked: boolean; inOrganization: boolean};
};

/**
 * The places with anything past their mark, or whose session may be due, at most `limit`, each
 * held for `workerId` for `leaseMs` as it is taken, so another instance's sweep doesn't take it
 * meanwhile; one whose holder stopped comes again then. Only places whose root message is posted,
 * whose app is installed and not removed, and that weren't stopped.
 *
 * A session is looked at again, unless the app's sessions are off or the place waits to try
 * again: where none was set; where it was set `processing` more than `renewMs` ago, or neither the
 * thread nor any of its sub-agents has a job still to run or running; where it was set otherwise
 * and either has one now, or it is `suspended` and the thread no longer waits for the member, or
 * was archived, or the other way round; and where the thread's title is no longer the one the session was given.
 * What it is then set to is the api's (slack/sessions.ts), by where the thread stands; this only
 * says when that may have changed. Most of what changes it writes an entry in the thread, which
 * the first condition finds. With nothing to do anywhere it is, per place, one probe of the
 * entries' `(threadId, seq)` index and a lookup of its thread by id; and for a place set
 * `processing`, probes of its thread's jobs and its sub-agents'.
 */
export async function claimSlackDeliveries(
	workerId: string,
	leaseMs: number,
	limit: number,
	renewMs: number,
): Promise<Result<SlackDelivery[], ApiError>> {
	return wrapDb(async () => {
		const claimed = await db.$queryRaw<Array<{id: string}>>`
			UPDATE "SlackThreadPlace" SET "nextAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseMs / 1000}), "claimedBy" = ${workerId}
			WHERE "id" IN (
				SELECT p."id" FROM "SlackThreadPlace" AS p
				JOIN "SlackApp" AS a ON a."id" = p."appId"
				JOIN "AgentThread" AS t ON t."id" = p."threadId"
				WHERE p."stoppedAt" IS NULL AND p."rootTs" IS NOT NULL AND p."nextAt" <= now() AT TIME ZONE 'UTC'
					AND a."removedAt" IS NULL AND a."botToken" IS NOT NULL
					AND (
						EXISTS (
							SELECT 1 FROM "AgentEntry" AS e
							WHERE e."threadId" = p."threadId" AND e."seq" > p."deliveredSeq" AND NOT e."pending"
						)
						OR (
							(a."sessionsOffUntil" IS NULL OR a."sessionsOffUntil" <= now() AT TIME ZONE 'UTC')
							AND (p."sessionRetryAt" IS NULL OR p."sessionRetryAt" <= now() AT TIME ZONE 'UTC')
							AND (
								p."sessionStatus" IS NULL
								OR (
									p."sessionStatus" = 'processing'
									AND (
										p."sessionSetAt" <= (now() AT TIME ZONE 'UTC') - make_interval(secs => ${renewMs / 1000})
										OR NOT (
											EXISTS (
												SELECT 1 FROM "AgentJob" AS j
												WHERE j."threadId" = p."threadId" AND j."status" IN ('queued', 'running')
											)
											OR EXISTS (
												SELECT 1 FROM "AgentJob" AS j
												JOIN "AgentThread" AS s ON s."id" = j."threadId"
												WHERE s."subAgentOfId" = p."threadId" AND j."status" IN ('queued', 'running')
											)
										)
									)
								)
								OR (
									p."sessionStatus" <> 'processing'
									AND (
										(p."sessionStatus" = 'suspended') <> (t."waitingForMember" AND NOT t."archived")
										OR EXISTS (
											SELECT 1 FROM "AgentJob" AS j
											WHERE j."threadId" = p."threadId" AND j."status" IN ('queued', 'running')
										)
										OR EXISTS (
											SELECT 1 FROM "AgentJob" AS j
											JOIN "AgentThread" AS s ON s."id" = j."threadId"
											WHERE s."subAgentOfId" = p."threadId" AND j."status" IN ('queued', 'running')
										)
									)
								)
								OR (t."title" IS NOT NULL AND t."title" IS DISTINCT FROM p."sessionTitle")
							)
						)
					)
				ORDER BY p."nextAt"
				LIMIT ${limit}
				FOR UPDATE OF p SKIP LOCKED
			)
			RETURNING "id"`;
		if (claimed.length === 0) {
			return [];
		}
		const places = await db.slackThreadPlace.findMany({
			where: {id: {in: claimed.map(({id}) => id)}},
			select: {
				...sessionPlaceSelect,
				deliveredSeq: true,
				partSeq: true,
				partsPosted: true,
				attempts: true,
				app: {
					select: {
						id: true,
						workspaceId: true,
						botToken: true,
						removedAt: true,
						sessionsOffUntil: true,
					},
				},
				thread: {
					select: {
						orgId: true,
						userId: true,
						org: {select: {experiments: true, insider: true}},
					},
				},
			},
		});
		const links = await db.slackMemberLink.findMany({
			where: {
				OR: places.map(({app, thread}) => ({
					workspaceId: app.workspaceId,
					orgId: thread.orgId,
					userId: thread.userId,
				})),
			},
			select: {workspaceId: true, orgId: true, userId: true},
		});
		const members = await db.orgMember.findMany({
			where: {OR: places.map(({thread}) => ({orgId: thread.orgId, userId: thread.userId}))},
			select: {orgId: true, userId: true},
		});
		return places.flatMap(
			({app, thread, rootTs, deliveredSeq, partSeq, partsPosted, attempts, ...place}) => {
				// Taken with its root posted, which is never taken back.
				if (rootTs === null) {
					return [];
				}
				const at = toSessionPlace(
					{...place, rootTs},
					{
						id: app.id,
						botToken: app.botToken,
						removedAt: app.removedAt,
						sessionsOffUntil: app.sessionsOffUntil,
					},
				);
				return [
					{
						...at,
						deliveredSeq,
						partSeq,
						partsPosted,
						attempts,
						thread: {orgId: thread.orgId, userId: thread.userId},
						org: {experiments: thread.org.experiments, insider: thread.org.insider},
						member: {
							linked: links.some(
								(link) =>
									link.workspaceId === app.workspaceId &&
									link.orgId === thread.orgId &&
									link.userId === thread.userId,
							),
							inOrganization: members.some(
								(member) => member.orgId === thread.orgId && member.userId === thread.userId,
							),
						},
					},
				];
			},
		);
	});
}

/** A sub-agent of the thread, by the call that started it, which says what of the thread is its. */
export type SlackSubAgentRow = {id: string; title: string | null; parentCallId: string | null};

/** What delivering a thread reads of it: its entries past the mark, and its sub-agents. */
export type SlackUndelivered = {entries: ShownEntryRow[]; subAgents: SlackSubAgentRow[]};

/**
 * The thread's entries past `afterSeq`, at most `limit`, in order, without what is pending, read
 * in one statement, so none is seen without every earlier one of the thread (as this module says),
 * and its sub-agents, read after, so every sub-agent an entry read names is among them; each entry
 * with the thread it was passed on from, where another of the member's threads passed it on. Every
 * kind is read, so the mark can move past what isn't shown; the words of what the member said in
 * Slack, of a call's result or of a summary aren't, nor the calls of anything but an answer. What
 * the member said that was passed on from another thread is read with its words, since it is
 * delivered.
 */
export async function readSlackUndelivered(
	threadId: string,
	afterSeq: number,
	limit: number,
): Promise<Result<SlackUndelivered, ApiError>> {
	return wrapDb(async () => {
		const rows = await db.$queryRaw<
			Array<{
				id: string;
				seq: number;
				kind: AgentEntryKind;
				pending: boolean;
				isError: boolean;
				createdAt: Date;
				callId: string | null;
				text: string;
				toolCalls: string | null;
				passedOnFromId: string | null;
			}>
		>`
			SELECT e."id", e."seq", e."kind", e."pending", e."isError", e."createdAt", e."callId", e."passedOnFromId",
				CASE
					WHEN e."kind" IN ('event', 'assistant') THEN e."text"
					WHEN e."kind" = 'person' AND e."passedOnFromId" IS NOT NULL THEN e."text"
					ELSE ''
				END AS "text",
				CASE WHEN e."kind" = 'assistant' THEN e."toolCalls" ELSE NULL END AS "toolCalls"
			FROM "AgentEntry" AS e
			WHERE e."threadId" = ${threadId} AND e."seq" > ${afterSeq} AND NOT e."pending"
			ORDER BY e."seq"
			LIMIT ${limit}`;
		const subAgents = await db.agentThread.findMany({
			where: {subAgentOfId: threadId},
			select: {id: true, title: true, parentCallId: true},
			orderBy: {createdAt: 'asc'},
		});
		return {
			entries: (await withPassedOn(rows)).map((row) => ({
				...row,
				toolCalls: toToolCalls(row.toolCalls),
			})),
			subAgents,
		};
	});
}

/** How far a place is delivered: every entry up to `deliveredSeq`, and of the entry `partSeq` its first `partsPosted` messages. */
export type SlackDeliveryMark = {deliveredSeq: number; partSeq: number | null; partsPosted: number};

/**
 * Moves the place's mark, where the worker still holds it, and holds it `leaseMs` more. `Ok(false)`
 * where the place is no longer the worker's, which then posts nothing more for it.
 */
export async function markSlackDelivered(
	placeId: string,
	workerId: string,
	mark: SlackDeliveryMark,
	leaseMs: number,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackThreadPlace.updateMany({
				where: {id: placeId, claimedBy: workerId},
				data: {...mark, attempts: 0, nextAt: new Date(Date.now() + leaseMs)},
			}),
		)
	).map(({count}) => count > 0);
}

/**
 * Lets the place go, where the worker still holds it: taken again from `delayMs` on, with
 * `attempts` failed tries at its next message. `Ok(false)` where it was no longer the worker's.
 */
export async function releaseSlackDelivery(
	placeId: string,
	workerId: string,
	delayMs: number,
	attempts: number,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackThreadPlace.updateMany({
				where: {id: placeId, claimedBy: workerId},
				data: {claimedBy: null, attempts, nextAt: new Date(Date.now() + delayMs)},
			}),
		)
	).map(({count}) => count > 0);
}

/** Stops delivering to the place for good, saying why, where the worker still holds it, as for a Slack thread that is gone. */
export async function stopSlackDelivery(
	placeId: string,
	workerId: string,
	why: string,
): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackThreadPlace.updateMany({
				where: {id: placeId, claimedBy: workerId},
				data: {claimedBy: null, stoppedAt: new Date(), stoppedWhy: why},
			}),
		)
	).map(({count}) => count > 0);
}
