import type {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';
import {threadState, type ThreadState} from '@proxy/utils/harness';

import {db} from '.';
import {type SlackThreadRow, slackThreadSelect, toSlackThread} from './harness';

/**
 * A member's Chat as a connection of theirs (`@proxy/integrations` chat): the connection itself,
 * and their threads across every persona, wherever each lives, in the app or in Slack, as a list of
 * them is read. One thread whole is read as
 * the Chat page reads it (harness.ts getMemberThread), and the alerts as the Alerts page does
 * (alerts.ts listMemberAlerts).
 */

/** Where a list of the member's threads is narrowed to: at work or asleep, waiting for them, watching with alerts that come to it, done, or archived by them. */
export type ThreadStandingFilter = 'in_progress' | 'waiting' | 'watching' | 'done' | 'archived';

/**
 * One of the member's threads as a list of them has it: whose it is with, where it lives, what it
 * is up to, where it stands, and the last entry of it the member sees, by which a summary is
 * current or stale.
 */
export type MemberThreadRow = {
	id: string;
	personaId: string;
	personaName: string;
	title: string | null;
	// Where it is in Slack, for one that lives there; null for one in the app.
	slack: SlackThreadRow | null;
	createdAt: Date;
	state: ThreadState;
	standing: {
		waitingForMember: boolean;
		summary: string | null;
		summarySeq: number | null;
		archived: boolean;
	};
	// How many of the member's alerts come to the thread, which wake it again.
	alerts: number;
	last: {seq: number; pending: boolean; createdAt: Date} | null;
};

const OPEN_JOBS = {status: {in: ['queued', 'running']}} satisfies Prisma.AgentJobWhereInput;

// The threads a standing picks: one with a job still to run or running is in progress, whatever
// its last turn's end said or whether it is archived; one with none is archived where the member
// archived it, and otherwise waits for the member where that said so, is watching where alerts
// come to it, and is done otherwise.
function standingWhere(standing: ThreadStandingFilter | null): Prisma.AgentThreadWhereInput {
	if (standing === null) {
		return {};
	}
	if (standing === 'in_progress') {
		return {jobs: {some: OPEN_JOBS}};
	}
	if (standing === 'archived') {
		return {jobs: {none: OPEN_JOBS}, archived: true};
	}
	if (standing === 'waiting') {
		return {jobs: {none: OPEN_JOBS}, archived: false, waitingForMember: true};
	}
	return {
		jobs: {none: OPEN_JOBS},
		archived: false,
		waitingForMember: false,
		alerts: standing === 'watching' ? {some: {}} : {none: {}},
	};
}

/**
 * The member's threads in the organization, with every persona, the one opened last first, `take`
 * of them from the `skip`th: those whose title or summary has `search`, in any case, and that stand
 * as `standing` says, where given. Each is read by its own row, its open jobs and its last entry,
 * not by what was said in it, so a long list is not read whole. With the organization's slug, for
 * their addresses; null for no such organization.
 */
export async function listMemberThreads(
	orgId: string,
	userId: string,
	query: {search: string | null; standing: ThreadStandingFilter | null; skip: number; take: number},
	now = new Date(),
): Promise<Result<{orgSlug: string; threads: MemberThreadRow[]} | null, ApiError>> {
	const {search, standing, skip, take} = query;
	const has = search === null ? null : {contains: search, mode: 'insensitive' as const};
	return wrapDb(async () => {
		const org = await db.organization.findUnique({where: {id: orgId}, select: {slug: true}});
		if (!org) {
			return null;
		}
		const threads = await db.agentThread.findMany({
			where: {
				orgId,
				userId,
				parentThreadId: {not: null},
				subAgentOfId: null,
				...standingWhere(standing),
				...(has === null ? {} : {OR: [{title: has}, {summary: has}]}),
			},
			select: {
				id: true,
				personaId: true,
				title: true,
				createdAt: true,
				waitingForMember: true,
				summary: true,
				summarySeq: true,
				archived: true,
				persona: {select: {name: true}},
				slackPlace: slackThreadSelect,
				jobs: {where: OPEN_JOBS, select: {kind: true, runAt: true}},
				_count: {select: {alerts: true}},
				// What the member said, an event that came, or what the agent answered in words: the
				// last of them is the last thing the thread shows.
				entries: {
					where: {OR: [{kind: {in: ['person', 'event']}}, {kind: 'assistant', text: {not: ''}}]},
					orderBy: [{pending: 'desc'}, {seq: 'desc'}],
					take: 1,
					select: {seq: true, pending: true, createdAt: true},
				},
			},
			orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
			skip,
			take,
		});
		return {
			orgSlug: org.slug,
			threads: threads.map(
				({
					persona,
					slackPlace,
					jobs,
					entries,
					waitingForMember,
					summary,
					summarySeq,
					archived,
					_count,
					...thread
				}) => ({
					...thread,
					personaName: persona.name,
					slack: toSlackThread(slackPlace),
					state: threadState(jobs, now),
					standing: {waitingForMember, summary, summarySeq, archived},
					alerts: _count.alerts,
					last: entries[0] ?? null,
				}),
			),
		};
	});
}

/**
 * What a thread's address is made of beside its id: the organization's slug, its persona's name,
 * which says whose it is with, and where it is in Slack, for one that lives there; null where the
 * thread is gone.
 */
export async function getThreadAddress(thread: {
	id: string;
	orgId: string;
}): Promise<
	Result<{orgSlug: string; personaName: string; slack: SlackThreadRow | null} | null, ApiError>
> {
	return wrapDb(async () => {
		const found = await db.agentThread.findFirst({
			where: {id: thread.id, orgId: thread.orgId},
			select: {
				org: {select: {slug: true}},
				persona: {select: {name: true}},
				slackPlace: slackThreadSelect,
			},
		});
		if (!found) {
			return null;
		}
		return {
			orgSlug: found.org.slug,
			personaName: found.persona.name,
			slack: toSlackThread(found.slackPlace),
		};
	});
}

/** The organization's slug, which every address in it begins with; null for no such organization. */
export async function getOrgSlug(orgId: string): Promise<Result<string | null, ApiError>> {
	return (
		await wrapDb(() => db.organization.findUnique({where: {id: orgId}, select: {slug: true}}))
	).map((org) => org?.slug ?? null);
}
