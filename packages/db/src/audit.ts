import {type AuditOutcome, type AuditVia, Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {type Viewer, visibleTo} from './viewer';

export type AuditEntryRow = {
	id: string;
	// None for what Personal Agent Proxy did itself.
	agentId: string | null;
	connectionId: string;
	collectionId: string;
	// list, view, create, update or delete, or a command of the collection, such as `send`.
	action: string;
	recordTitle: string | null;
	query: string | null;
	outcome: AuditOutcome;
	via: AuditVia;
	// The agent's task it was for (task.ts); none for entries from before tasks, and for what
	// Personal Agent Proxy did itself.
	taskId: string | null;
	// How long the request took, from when it came in to when it was logged; none for entries from
	// before this was kept, and for what Personal Agent Proxy did itself.
	durationMs: number | null;
	// The member who asked for what Personal Agent Proxy did itself; none for an agent's request,
	// and for entries from before it was kept.
	userId: string | null;
	// What went wrong, for a failed request (schema.prisma); none for every other outcome.
	error: string | null;
	createdAt: Date;
};

const entrySelect = {
	id: true,
	agentId: true,
	connectionId: true,
	collectionId: true,
	action: true,
	recordTitle: true,
	query: true,
	outcome: true,
	via: true,
	taskId: true,
	durationMs: true,
	userId: true,
	error: true,
	createdAt: true,
} as const;

/** Logs one request of an agent, made for one of its tasks, and marks the agent active now. */
export async function logAgentRequest(data: {
	orgId: string;
	agentId: string;
	connectionId: string;
	collectionId: string;
	action: string;
	recordTitle: string | null;
	query: string | null;
	outcome: AuditOutcome;
	via: AuditVia;
	// PRE-TASK CLIENTS: null for a call of an MCP client from before tasks (api's mcp/pre-task-clients.ts).
	taskId: string | null;
	// The member whose own the agent is, who alone sees the entry; null for a shared agent's.
	ownerUserId: string | null;
	// When the request came in, in ms since the epoch, so the entry says how long it took.
	startedAt: number;
	// What went wrong, for a failed request.
	error?: string;
}): Promise<Result<void, ApiError>> {
	const {startedAt, ...entry} = data;
	return wrapDb(async () => {
		await db.$transaction([
			db.auditEntry.create({data: {...entry, durationMs: Date.now() - startedAt}}),
			db.agent.update({where: {id: data.agentId}, data: {lastActiveAt: new Date()}}),
		]);
	});
}

/**
 * Logs one thing Personal Agent Proxy did itself for a person, such as making an event from the
 * home page: an entry without an agent, always allowed, since the person asked for it. Whose entry
 * it is (`ownerUserId`) is whose own the connection is: everyone's for a shared one; who asked
 * (`userId`) is kept either way.
 */
export async function logProxyAction(data: {
	orgId: string;
	connectionId: string;
	collectionId: string;
	action: string;
	recordTitle: string | null;
	ownerUserId: string | null;
	userId: string;
}): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.auditEntry.create({
			data: {
				...data,
				agentId: null,
				query: null,
				outcome: 'allowed',
				taskId: null,
				durationMs: null,
				error: null,
			},
		});
	});
}

/**
 * The entries the viewer sees, newest first: the organization's shared agents' and shared
 * connections', and their own; optionally only one agent's or one connection's requests, only one
 * task's, or only allowed, denied or failed ones; an `agentId` of null is what Personal Agent Proxy
 * did itself.
 */
export async function listAuditEntries(
	viewer: Viewer,
	filter: {
		agentId?: string | null;
		connectionId?: string;
		taskId?: string;
		outcome?: AuditOutcome;
	},
	take: number,
): Promise<Result<AuditEntryRow[], ApiError>> {
	return wrapDb(() =>
		db.auditEntry.findMany({
			where: {...visibleTo(viewer), ...filter},
			orderBy: {createdAt: 'desc'},
			take,
			select: entrySelect,
		}),
	);
}

// What visibleTo says, for a query written out in SQL.
function visibleSql(viewer: Viewer): Prisma.Sql {
	return Prisma.sql`"orgId" = ${viewer.orgId} AND ("ownerUserId" IS NULL OR "ownerUserId" = ${viewer.userId})`;
}

/**
 * The requests the viewer sees made for any of `taskIds`, between `between.from` and `between.to`
 * where given, in the order they were made: at most `take` in all, shared out among the tasks, so
 * every task keeps its newest requests, all of them where they fit and its newest share of them
 * where it has more.
 */
export async function listTaskEntries(
	viewer: Viewer,
	taskIds: string[],
	take: number,
	between: {from: Date; to: Date} | null = null,
): Promise<Result<AuditEntryRow[], ApiError>> {
	if (taskIds.length === 0) {
		return wrapDb(async () => []);
	}
	const where = {
		...visibleTo(viewer),
		taskId: {in: taskIds},
		...(between === null ? {} : {createdAt: {gte: between.from, lte: between.to}}),
	};
	return wrapDb(async () => {
		const counts = await db.auditEntry.groupBy({by: ['taskId'], where, _count: {_all: true}});
		const share = fairShare(
			counts.map((row) => row._count._all),
			take,
		);
		if (share === null) {
			return db.auditEntry.findMany({where, orderBy: {createdAt: 'asc'}, select: entrySelect});
		}
		const newest = await db.$queryRaw<Array<{id: string}>>`
			SELECT "id" FROM (
				SELECT "id", ROW_NUMBER() OVER (PARTITION BY "taskId" ORDER BY "createdAt" DESC, "id" DESC) AS "rank"
				FROM "AuditEntry"
				WHERE ${visibleSql(viewer)}
					AND "taskId" IN (${Prisma.join(taskIds)})
					${between === null ? Prisma.empty : Prisma.sql`AND "createdAt" >= ${between.from} AND "createdAt" <= ${between.to}`}
			) AS "ranked"
			WHERE "rank" <= ${share}`;
		return db.auditEntry.findMany({
			where: {id: {in: newest.map((row) => row.id)}},
			orderBy: {createdAt: 'asc'},
			select: entrySelect,
		});
	});
}

/**
 * The last request the viewer sees made for each of `taskIds` after `after`, where one was, in the
 * order they were made: for a stretch of time read that ends before now, when a task left open
 * last had anything done for it, which is when the web app shows it as having ended.
 */
export async function listLastTaskEntries(
	viewer: Viewer,
	taskIds: string[],
	after: Date,
): Promise<Result<AuditEntryRow[], ApiError>> {
	if (taskIds.length === 0) {
		return wrapDb(async () => []);
	}
	return wrapDb(async () => {
		const last = await db.$queryRaw<Array<{id: string}>>`
			SELECT DISTINCT ON ("taskId") "id"
			FROM "AuditEntry"
			WHERE ${visibleSql(viewer)}
				AND "taskId" IN (${Prisma.join(taskIds)})
				AND "createdAt" > ${after}
			ORDER BY "taskId", "createdAt" DESC, "id" DESC`;
		return db.auditEntry.findMany({
			where: {id: {in: last.map((row) => row.id)}},
			orderBy: {createdAt: 'asc'},
			select: entrySelect,
		});
	});
}

/**
 * How many requests each task keeps where tasks with `counts` requests share `take`: the most that
 * fits, a task with fewer keeping all of its own, and at least one; null where every request fits.
 */
export function fairShare(counts: number[], take: number): number | null {
	if (counts.reduce((total, count) => total + count, 0) <= take) {
		return null;
	}
	const sorted = counts.toSorted((a, b) => a - b);
	let left = take;
	for (const [index, count] of sorted.entries()) {
		const sharing = sorted.length - index;
		if (count * sharing > left) {
			return Math.max(Math.floor(left / sharing), 1);
		}
		left -= count;
	}
	return null;
}
