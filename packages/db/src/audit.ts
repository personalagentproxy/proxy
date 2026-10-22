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
	// How long the request took, from when it came in to when it was logged; none for entries from
	// before this was kept, and for what Personal Agent Proxy did itself.
	durationMs: number | null;
	// What went wrong, for a failed request (schema.prisma); none for every other outcome.
	error: string | null;
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
	// PRE-TASK CLIENTS: null for a call of an MCP client from before tasks (api's mcp/pre-task-clients.ts).
	taskId: string | null;
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
 * Newest first, optionally only one agent's or one connection's requests, only one task's, or only
 * allowed, denied or failed ones; an `agentId` of null is what Personal Agent Proxy did itself.
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
				durationMs: true,
				error: true,
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
