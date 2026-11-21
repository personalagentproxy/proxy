import type {SlackSessionStatus} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';
import {type ThreadState, threadState} from '@proxy/utils/harness';

import {db} from '.';
import {openJobsSelect} from './harness';

export type {SlackSessionStatus} from '@prisma/client';

/**
 * Where a thread with a place in Slack stands there, as its Slack agent session's status and
 * title: what each place last set, the title it last gave, and when, with its failures in a row
 * and when to try again; and the apps whose workspace has no agent sessions for now. What is set,
 * and when, is the api's (slack/sessions.ts).
 */

/** The status a place last set, the title it last gave the session, when, and how its last tries went. */
export type SlackSessionMark = {
	status: SlackSessionStatus | null;
	title: string | null;
	setAt: Date | null;
	attempts: number;
	retryAt: Date | null;
};

/** A thread's place in Slack as setting its session's status needs it. */
export type SlackSessionPlace = {
	id: string;
	threadId: string;
	channel: string;
	rootTs: string;
	session: SlackSessionMark;
	app: {id: string; botToken: string | null; removedAt: Date | null; sessionsOffUntil: Date | null};
};

/** The columns of a place a session is set by, as `toSessionPlace` reads them. */
export const sessionPlaceSelect = {
	id: true,
	threadId: true,
	channel: true,
	rootTs: true,
	sessionStatus: true,
	sessionTitle: true,
	sessionSetAt: true,
	sessionAttempts: true,
	sessionRetryAt: true,
} as const;

/** A place as read with `sessionPlaceSelect`, with its app, its root message posted. */
export function toSessionPlace(
	place: {
		id: string;
		threadId: string;
		channel: string;
		rootTs: string;
		sessionStatus: SlackSessionStatus | null;
		sessionTitle: string | null;
		sessionSetAt: Date | null;
		sessionAttempts: number;
		sessionRetryAt: Date | null;
	},
	app: SlackSessionPlace['app'],
): SlackSessionPlace {
	return {
		id: place.id,
		threadId: place.threadId,
		channel: place.channel,
		rootTs: place.rootTs,
		session: {
			status: place.sessionStatus,
			title: place.sessionTitle,
			setAt: place.sessionSetAt,
			attempts: place.sessionAttempts,
			retryAt: place.sessionRetryAt,
		},
		app,
	};
}

/**
 * The thread's place in Slack, as setting its session's status needs it; `Ok(null)` for a thread
 * with none, and for one that is stopped, whose root message isn't posted yet, or whose app is
 * removed or not installed, which are left alone.
 */
export async function getSlackSessionPlace(
	threadId: string,
): Promise<Result<SlackSessionPlace | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackThreadPlace.findFirst({
				where: {
					threadId,
					stoppedAt: null,
					rootTs: {not: null},
					app: {removedAt: null, botToken: {not: null}},
				},
				select: {
					...sessionPlaceSelect,
					app: {select: {id: true, botToken: true, removedAt: true, sessionsOffUntil: true}},
				},
			}),
		)
	).map((place) => {
		if (place === null || place.rootTs === null) {
			return null;
		}
		return toSessionPlace({...place, rootTs: place.rootTs}, place.app);
	});
}

/**
 * Where a thread stands, as its session shows it: what its agent is up to, whether it waits for the
 * member, whether they archived it, how many alerts come to it, whether any of its sub-agents still has a turn or a call to
 * run, now or after a sleep, its title, and the `seq` of the last entry written in it, nothing
 * pending; `Ok(null)` for no such thread. Read as of one moment, so what it says is true of the
 * entries up to `lastSeq`: an answer and the end of its job are written together
 * (completeInference), so a thread read as stopped has its answer at or before `lastSeq`.
 */
export type SlackSessionState = {
	state: ThreadState;
	waitingForMember: boolean;
	archived: boolean;
	alerts: number;
	subAgentsAtWork: boolean;
	title: string | null;
	lastSeq: number;
};

/** The thread as its session shows it, as of `now`. */
export async function readSlackSessionState(
	threadId: string,
	now: Date,
): Promise<Result<SlackSessionState | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.$transaction(
				[
					db.agentThread.findUnique({
						where: {id: threadId},
						select: {
							title: true,
							waitingForMember: true,
							archived: true,
							jobs: openJobsSelect,
							_count: {select: {alerts: true}},
						},
					}),
					db.agentJob.count({
						where: {status: {in: ['queued', 'running']}, thread: {subAgentOfId: threadId}},
					}),
					db.agentEntry.aggregate({where: {threadId, pending: false}, _max: {seq: true}}),
				],
				{isolationLevel: 'RepeatableRead'},
			),
		)
	).map(([thread, subAgentJobs, entries]) => {
		if (thread === null) {
			return null;
		}
		return {
			state: threadState(thread.jobs, now),
			waitingForMember: thread.waitingForMember,
			archived: thread.archived,
			alerts: thread._count.alerts,
			subAgentsAtWork: subAgentJobs > 0,
			title: thread.title,
			lastSeq: entries._max.seq ?? 0,
		};
	});
}

/**
 * Notes that the place's session was set to `status` at `at`, its failures over; and, where the
 * call made the session, the title it was made with (`made`).
 */
export async function noteSlackSessionSet(
	placeId: string,
	status: SlackSessionStatus,
	at: Date,
	made: {title: string | null} | null,
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackThreadPlace.updateMany({
				where: {id: placeId},
				data: {
					sessionStatus: status,
					sessionSetAt: at,
					sessionAttempts: 0,
					sessionRetryAt: null,
					...(made === null ? {} : {sessionTitle: made.title}),
				},
			}),
		)
	).map(() => undefined);
}

/** Notes that the place's session was renamed to `title`, its failures over. */
export async function noteSlackSessionRenamed(
	placeId: string,
	title: string,
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackThreadPlace.updateMany({
				where: {id: placeId},
				data: {sessionTitle: title, sessionAttempts: 0, sessionRetryAt: null},
			}),
		)
	).map(() => undefined);
}

/** Notes that setting the place's session failed, `attempts` times in a row now, to be tried again from `retryAt`. */
export async function noteSlackSessionFailed(
	placeId: string,
	attempts: number,
	retryAt: Date,
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackThreadPlace.updateMany({
				where: {id: placeId},
				data: {sessionAttempts: attempts, sessionRetryAt: retryAt},
			}),
		)
	).map(() => undefined);
}

/** No session calls for the app until `until`: Slack said its agent features aren't there for it. */
export async function turnSlackSessionsOff(
	appId: string,
	until: Date,
): Promise<Result<void, ApiError>> {
	return (
		await wrapDb(() =>
			db.slackApp.updateMany({where: {id: appId}, data: {sessionsOffUntil: until}}),
		)
	).map(() => undefined);
}
