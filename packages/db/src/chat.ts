import type {Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';
import {threadState, type ThreadState} from '@proxy/utils/harness';

import {db} from '.';

/**
 * A member's Chat as a connection of theirs (`@proxy/integrations` chat): the connection itself,
 * and their threads across every persona, as a list of them is read. One thread whole is read as
 * the Chat page reads it (harness.ts getMemberThread), and the alerts as the Alerts page does
 * (alerts.ts listMemberAlerts).
 */

/**
 * The member's own Chat connection in an organization, made where they have none, once the
 * organization has the built-in agent the Chat page's personas act through (`providerId`), which
 * is when there can be a thread to read: called by the organization's name, as their vault is,
 * with nothing an agent may do by default, and `actions` allowed to the built-in agent alone, in
 * its own settings, where the member turns them off as for any agent. Once however many ask at
 * once: the second finds the first's.
 */
export function createMissingChatConnection(data: {
	orgId: string;
	userId: string;
	integrationId: string;
	providerId: string;
	actions: string[];
}): Promise<Result<void, ApiError>> {
	const {orgId, userId, integrationId, providerId, actions} = data;
	const mine = {orgId, integrationId, ownerUserId: userId, name: null};
	return wrapDb(async () => {
		// Most ask where it is there already, or where the organization has not used Chat: they are
		// answered without waiting on the lock.
		if (await db.connection.findFirst({where: mine, select: {id: true}})) {
			return;
		}
		if (
			!(await db.agent.findFirst({
				where: {orgId, providerId, ownerUserId: null},
				select: {id: true},
			}))
		) {
			return;
		}
		await db.$transaction(async (tx) => {
			const locked = await tx.$queryRaw<
				Array<{name: string}>
			>`SELECT "name" FROM "Organization" WHERE "id" = ${orgId} FOR UPDATE`;
			const [org] = locked;
			if (!org) {
				return;
			}
			const builtIn = await tx.agent.findFirst({
				where: {orgId, providerId, ownerUserId: null},
				select: {id: true},
				orderBy: {createdAt: 'asc'},
			});
			if (!builtIn || (await tx.connection.findFirst({where: mine, select: {id: true}}))) {
				return;
			}
			const made = await tx.connection.create({
				data: {orgId, ownerUserId: userId, integrationId, account: org.name},
				select: {id: true},
			});
			await tx.agentGrant.createMany({
				data: actions.map((actionId) => ({
					agentId: builtIn.id,
					connectionId: made.id,
					actionId,
					allowed: true,
				})),
			});
		});
	});
}

/** Where a list of the member's threads is narrowed to: at work or asleep, waiting for them, done, or archived by them. */
export type ThreadStandingFilter = 'in_progress' | 'waiting' | 'done' | 'archived';

/**
 * One of the member's threads as a list of them has it: whose it is with, what it is up to, where
 * it stands, and the last entry of it the member sees, by which a summary is current or stale.
 */
export type MemberThreadRow = {
	id: string;
	personaId: string;
	personaName: string;
	title: string | null;
	createdAt: Date;
	state: ThreadState;
	standing: {
		waitingForMember: boolean;
		summary: string | null;
		summarySeq: number | null;
		archived: boolean;
	};
	last: {seq: number; pending: boolean; createdAt: Date} | null;
};

const OPEN_JOBS = {status: {in: ['queued', 'running']}} satisfies Prisma.AgentJobWhereInput;

// The threads a standing picks: one with a job still to run or running is in progress, whatever
// its last turn's end said or whether it is archived; one with none is archived where the member
// archived it, and otherwise waits for the member where that said so, and is done otherwise.
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
	return {jobs: {none: OPEN_JOBS}, archived: false, waitingForMember: standing === 'waiting'};
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
				jobs: {where: OPEN_JOBS, select: {kind: true, runAt: true}},
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
				({persona, jobs, entries, waitingForMember, summary, summarySeq, archived, ...thread}) => ({
					...thread,
					personaName: persona.name,
					state: threadState(jobs, now),
					standing: {waitingForMember, summary, summarySeq, archived},
					last: entries[0] ?? null,
				}),
			),
		};
	});
}

/** What a thread's address is made of beside its id: the organization's slug, and its persona's name, which says whose it is with; null where either is gone. */
export async function getThreadPlace(
	orgId: string,
	personaId: string,
): Promise<Result<{orgSlug: string; personaName: string} | null, ApiError>> {
	return wrapDb(async () => {
		const persona = await db.persona.findFirst({
			where: {id: personaId, orgId},
			select: {name: true, org: {select: {slug: true}}},
		});
		return persona ? {orgSlug: persona.org.slug, personaName: persona.name} : null;
	});
}

/** The organization's slug, which every address in it begins with; null for no such organization. */
export async function getOrgSlug(orgId: string): Promise<Result<string | null, ApiError>> {
	return (
		await wrapDb(() => db.organization.findUnique({where: {id: orgId}, select: {slug: true}}))
	).map((org) => org?.slug ?? null);
}
