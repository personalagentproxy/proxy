import type {AuditOutcome, AuditVia} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

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
	createdAt: Date;
};

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
	taskId: string;
}): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.$transaction([
			db.auditEntry.create({data}),
			db.agent.update({where: {id: data.agentId}, data: {lastActiveAt: new Date()}}),
		]);
	});
}

/**
 * Logs one thing Personal Agent Proxy did itself for a person, such as making an event from the
 * home page: an entry without an agent, always allowed, since the person asked for it.
 */
export async function logProxyAction(data: {
	orgId: string;
	connectionId: string;
	collectionId: string;
	action: string;
	recordTitle: string | null;
}): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.auditEntry.create({
			data: {...data, agentId: null, query: null, outcome: 'allowed', taskId: null},
		});
	});
}

/**
 * Newest first, optionally only one agent's or one connection's requests, only one task's, or only
 * allowed or denied ones; an `agentId` of null is what Personal Agent Proxy did itself.
 */
export async function listAuditEntries(
	orgId: string,
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
			where: {orgId, ...filter},
			orderBy: {createdAt: 'desc'},
			take,
			select: {
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
				createdAt: true,
			},
		}),
	);
}

export type TaskRequestSummary = {
	taskId: string;
	connectionId: string;
	outcome: AuditOutcome;
	count: number;
	// When the first of these requests was made.
	first: Date;
};

/** The requests made for each of `taskIds`, counted by connection and outcome. */
export async function summarizeTaskRequests(
	orgId: string,
	taskIds: string[],
): Promise<Result<TaskRequestSummary[], ApiError>> {
	if (taskIds.length === 0) {
		return wrapDb(async () => []);
	}
	const grouped = await wrapDb(() =>
		db.auditEntry.groupBy({
			by: ['taskId', 'connectionId', 'outcome'],
			where: {orgId, taskId: {in: taskIds}},
			_count: {_all: true},
			_min: {createdAt: true},
		}),
	);
	return grouped.map((rows) =>
		rows.flatMap((row) => {
			if (row.taskId === null || row._min.createdAt === null) {
				return [];
			}
			return [
				{
					taskId: row.taskId,
					connectionId: row.connectionId,
					outcome: row.outcome,
					count: row._count._all,
					first: row._min.createdAt,
				},
			];
		}),
	);
}
