import type {AuditVia, Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';
import {TASK_ABANDONED_AFTER_MS} from '@proxy/utils/tasks';

import {db} from '.';
import type {Viewer} from './connection';

/** What an agent set out to do, as it named it when it started. */
export type AgentTaskRow = {
	id: string;
	agentId: string;
	// The task this one is a sub-task of; null for one started on its own.
	parentId: string | null;
	title: string;
	goal: string;
	via: AuditVia;
	createdAt: Date;
	// Null while the task is under way.
	finishedAt: Date | null;
	// What was done or found, as the agent said when it finished; null where it said nothing.
	outcome: string | null;
};

const taskSelect = {
	id: true,
	agentId: true,
	parentId: true,
	title: true,
	goal: true,
	via: true,
	createdAt: true,
	finishedAt: true,
	outcome: true,
} as const;

/**
 * Starts a task for the agent: what it is called and what the person asked for, and the agent's
 * task it is a sub-task of, where it is one. The parent is locked while the sub-task is made, so it
 * can't be finished in between and leave the sub-task open; `Ok(null)` means it is no longer under
 * way, finished or abandoned (@proxy/utils/tasks). `ownerUserId` is the member whose own the agent
 * is, who alone sees the task; null for a shared agent's.
 */
export async function createAgentTask(data: {
	orgId: string;
	agentId: string;
	ownerUserId: string | null;
	parentId: string | null;
	title: string;
	goal: string;
	via: AuditVia;
}): Promise<Result<AgentTaskRow | null, ApiError>> {
	const {orgId, agentId, parentId} = data;
	if (parentId === null) {
		return wrapDb(() => db.agentTask.create({data, select: taskSelect}));
	}
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const abandonedBefore = new Date(Date.now() - TASK_ABANDONED_AFTER_MS);
			const parent = await tx.$queryRaw<Array<{id: string}>>`
				SELECT "id" FROM "AgentTask"
				WHERE "id" = ${parentId} AND "orgId" = ${orgId} AND "agentId" = ${agentId}
					AND "finishedAt" IS NULL AND "createdAt" > ${abandonedBefore}
				FOR UPDATE`;
			if (parent.length === 0) {
				return null;
			}
			return tx.agentTask.create({data, select: taskSelect});
		}),
	);
}

/** `Ok(null)` means the agent has no such task: unknown, or another agent's. */
export async function getAgentTask(
	orgId: string,
	agentId: string,
	taskId: string,
): Promise<Result<AgentTaskRow | null, ApiError>> {
	return wrapDb(() =>
		db.agentTask.findFirst({where: {id: taskId, orgId, agentId}, select: taskSelect}),
	);
}

/**
 * Marks the agent's task finished now, with what was done where the agent said, and its sub-tasks
 * still under way finished with it, in one transaction. One already finished keeps the time it was,
 * and takes the outcome only where it has none, as a sub-task finished with its parent does; one
 * abandoned (@proxy/utils/tasks) stays as it is, ended when it was abandoned. `Ok(null)` means the
 * agent has no such task.
 */
export async function finishAgentTask(
	orgId: string,
	agentId: string,
	taskId: string,
	outcome: string | null,
): Promise<Result<AgentTaskRow | null, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const finishedAt = new Date();
			const abandonedBefore = new Date(finishedAt.getTime() - TASK_ABANDONED_AFTER_MS);
			const {count} = await tx.agentTask.updateMany({
				where: {id: taskId, orgId, agentId, finishedAt: null, createdAt: {gt: abandonedBefore}},
				data: {finishedAt, outcome},
			});
			if (count > 0) {
				await finishSubTasks(tx, {orgId, agentId, finishedAt, abandonedBefore}, [taskId]);
			}
			if (count === 0 && outcome !== null) {
				await tx.agentTask.updateMany({
					where: {id: taskId, orgId, agentId, finishedAt: {not: null}, outcome: null},
					data: {outcome},
				});
			}
			return tx.agentTask.findFirst({where: {id: taskId, orgId, agentId}, select: taskSelect});
		}),
	);
}

// Finishes the sub-tasks of `parentIds` still under way, level by level down the tree. Each level
// is read after the one above is updated, which waits for a sub-task being made under it
// (createAgentTask), so none is left open. An abandoned sub-task keeps when it ended, but its own
// sub-tasks, started before it was abandoned, may still be under way.
async function finishSubTasks(
	tx: Prisma.TransactionClient,
	at: {orgId: string; agentId: string; finishedAt: Date; abandonedBefore: Date},
	parentIds: string[],
): Promise<void> {
	const open = await tx.agentTask.findMany({
		where: {orgId: at.orgId, agentId: at.agentId, parentId: {in: parentIds}, finishedAt: null},
		select: {id: true},
	});
	if (open.length === 0) {
		return;
	}
	const ids = open.map((task) => task.id);
	// Not one finished since it was read, which keeps its own time and outcome.
	await tx.agentTask.updateMany({
		where: {id: {in: ids}, finishedAt: null, createdAt: {gt: at.abandonedBefore}},
		data: {finishedAt: at.finishedAt},
	});
	await finishSubTasks(tx, at, ids);
}

/** The agent's tasks still under way, newest first: none finished, and none abandoned (@proxy/utils/tasks). */
export async function listOpenAgentTasks(
	orgId: string,
	agentId: string,
): Promise<Result<AgentTaskRow[], ApiError>> {
	return wrapDb(() =>
		db.agentTask.findMany({
			where: {
				orgId,
				agentId,
				finishedAt: null,
				createdAt: {gt: new Date(Date.now() - TASK_ABANDONED_AFTER_MS)},
			},
			select: taskSelect,
			orderBy: {createdAt: 'desc'},
		}),
	);
}

/**
 * The tasks the viewer sees, shared agents' and their own agents', under way at some point since
 * `from`: started before now and not finished before `from`, nor abandoned before it, a day after
 * it started; the newest `take` of them, newest first.
 */
export async function listAgentTasksSince(
	viewer: Viewer,
	from: Date,
	take: number,
): Promise<Result<AgentTaskRow[], ApiError>> {
	return wrapDb(() =>
		db.agentTask.findMany({
			where: {
				orgId: viewer.orgId,
				AND: [{OR: [{ownerUserId: null}, {ownerUserId: viewer.userId}]}],
				OR: [
					{finishedAt: {gte: from}},
					{finishedAt: null, createdAt: {gte: new Date(from.getTime() - TASK_ABANDONED_AFTER_MS)}},
				],
			},
			select: taskSelect,
			orderBy: {createdAt: 'desc'},
			take,
		}),
	);
}

/** The tasks the viewer sees among `ids`, for naming what the activity log's entries were for. */
export async function listAgentTasks(
	viewer: Viewer,
	ids: string[],
): Promise<Result<AgentTaskRow[], ApiError>> {
	if (ids.length === 0) {
		return wrapDb(async () => []);
	}
	return wrapDb(() =>
		db.agentTask.findMany({
			where: {
				orgId: viewer.orgId,
				id: {in: ids},
				OR: [{ownerUserId: null}, {ownerUserId: viewer.userId}],
			},
			select: taskSelect,
		}),
	);
}
