import type {AuditVia, Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';
import {TASK_LEFT_OPEN_AFTER_MS} from '@proxy/utils/tasks';

import {db} from '.';
import {type Viewer, visibleTo} from './viewer';

/** What an agent set out to do, as it named it when it started. */
export type AgentTaskRow = {
	id: string;
	agentId: string;
	// The persona a Chat page sub-agent ran it as; null for every other task.
	personaId: string | null;
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
	// When it, or one of its sub-tasks at any depth, was last started or had a request made for it:
	// one never finished is taken as left open 20 minutes after (@proxy/utils/tasks).
	lastActiveAt: Date;
};

const taskSelect = {
	id: true,
	agentId: true,
	personaId: true,
	parentId: true,
	title: true,
	goal: true,
	via: true,
	createdAt: true,
	finishedAt: true,
	outcome: true,
	lastActiveAt: true,
} as const;

/**
 * Starts a task for the agent: what it is called and what the person asked for, and the agent's
 * task it is a sub-task of, where it is one. The parent and every task above it are locked while
 * the sub-task is made, so none can be finished in between and leave the sub-task open, and each
 * takes the sub-task's start as the last thing done for it (`lastActiveAt`), so none is left open
 * before it, and one left open is taken up again; `Ok(null)` means the parent, or a task above it,
 * is finished (@proxy/utils/tasks). `ownerUserId` is the member whose own the agent is, who alone
 * sees the task; null for a shared agent's.
 */
export async function createAgentTask(data: {
	orgId: string;
	agentId: string;
	ownerUserId: string | null;
	// The persona a Chat page sub-agent runs it as; null for every other task.
	personaId?: string | null;
	parentId: string | null;
	title: string;
	goal: string;
	via: AuditVia;
}): Promise<Result<AgentTaskRow | null, ApiError>> {
	const {orgId, agentId, parentId} = data;
	if (parentId === null) {
		return wrapDb(() => {
			const now = new Date();
			return db.agentTask.create({
				data: {...data, createdAt: now, lastActiveAt: now},
				select: taskSelect,
			});
		});
	}
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const now = new Date();
			if (!(await touchLine(tx, {orgId, agentId, taskId: parentId}, now))) {
				return null;
			}
			return tx.agentTask.create({
				data: {...data, createdAt: now, lastActiveAt: now},
				select: taskSelect,
			});
		}),
	);
}

/**
 * Takes now as the last thing done for the agent's task `taskId` and every task above it, as a
 * request made for it is (`lastActiveAt`), so none is left open while the agent is still at work on
 * it, and one left open is taken up again (@proxy/utils/tasks). `Ok(false)` means it, or a task
 * above it, is finished, or the agent has no such task.
 */
export async function touchAgentTask(
	orgId: string,
	agentId: string,
	taskId: string,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(() => db.$transaction((tx) => touchLine(tx, {orgId, agentId, taskId}, new Date())));
}

// Locks the task and every task above it, and takes `now` as the last thing done for each; false,
// with none changed, where any of them is finished. So a task taken up again takes up every task
// above it too, none left open before it; and one left open when its parent was finished, which
// it was not finished with (finishSubTasks), stays as it is.
async function touchLine(
	tx: Prisma.TransactionClient,
	{orgId, agentId, taskId}: {orgId: string; agentId: string; taskId: string},
	now: Date,
): Promise<boolean> {
	// Locked from the top down, the order finishing a task locks its sub-tasks in (finishSubTasks),
	// so the two can't wait on each other.
	const above = await tx.$queryRaw<
		Array<{id: string; finishedAt: Date | null; lastActiveAt: Date}>
	>`
		WITH RECURSIVE "line" AS (
			SELECT "id", "parentId", 0 AS "depth" FROM "AgentTask"
			WHERE "id" = ${taskId} AND "orgId" = ${orgId} AND "agentId" = ${agentId}
			UNION ALL
			SELECT "task"."id", "task"."parentId", "line"."depth" + 1
			FROM "AgentTask" AS "task"
			JOIN "line" ON "task"."id" = "line"."parentId"
		)
		SELECT "task"."id", "task"."finishedAt", "task"."lastActiveAt"
		FROM "AgentTask" AS "task"
		JOIN "line" ON "task"."id" = "line"."id"
		ORDER BY "line"."depth" DESC
		FOR UPDATE OF "task"`;
	if (!above.some((row) => row.id === taskId) || above.some((row) => row.finishedAt !== null)) {
		return false;
	}
	// Where another instance's clock is ahead, one may have set a later time already.
	await tx.agentTask.updateMany({
		where: {id: {in: above.map((row) => row.id)}, lastActiveAt: {lt: now}},
		data: {lastActiveAt: now},
	});
	return true;
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
 * still under way finished with it, in one transaction. Finishing is something done for it and
 * every task above it, as a request is (touchLine), so one left open (@proxy/utils/tasks) is taken
 * up again to be finished. One already finished keeps the time it was, and takes the outcome only
 * where it has none, as a sub-task finished with its parent does; one left open under a task
 * finished without it stays as it is, ended when it was left open. `Ok(null)` means the agent has
 * no such task.
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
			const open = await touchLine(tx, {orgId, agentId, taskId}, finishedAt);
			if (open) {
				await tx.agentTask.update({where: {id: taskId}, data: {finishedAt, outcome}});
				const leftOpenBefore = new Date(finishedAt.getTime() - TASK_LEFT_OPEN_AFTER_MS);
				await finishSubTasks(tx, {orgId, agentId, finishedAt, leftOpenBefore}, [taskId]);
			}
			if (!open && outcome !== null) {
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
// (createAgentTask), so none is left under way. One left open keeps when it ended, as do its own
// sub-tasks, left open no later than it, and can't be taken up again (touchLine).
async function finishSubTasks(
	tx: Prisma.TransactionClient,
	at: {orgId: string; agentId: string; finishedAt: Date; leftOpenBefore: Date},
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
		where: {id: {in: ids}, finishedAt: null, lastActiveAt: {gt: at.leftOpenBefore}},
		data: {finishedAt: at.finishedAt},
	});
	await finishSubTasks(tx, at, ids);
}

/** The agent's tasks still under way, newest first: none finished, and none left open (@proxy/utils/tasks). */
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
				lastActiveAt: {gt: new Date(Date.now() - TASK_LEFT_OPEN_AFTER_MS)},
			},
			select: taskSelect,
			orderBy: {createdAt: 'desc'},
		}),
	);
}

/**
 * The tasks the viewer sees, shared agents' and their own agents', under way at some point between
 * `from` and `to`: started by `to` and not finished before `from`, nor left open before it, 20
 * minutes after anything was last done for it or its sub-tasks. Of those, the newest `take`
 * started on their own, newest first; a sub-task ends no later than its parent, which is under way
 * then too, so the rest are sub-tasks of these (listSubTasks).
 */
export async function listAgentTasksBetween(
	viewer: Viewer,
	from: Date,
	to: Date,
	take: number,
): Promise<Result<AgentTaskRow[], ApiError>> {
	const activeSince = new Date(from.getTime() - TASK_LEFT_OPEN_AFTER_MS);
	return wrapDb(() =>
		db.agentTask.findMany({
			where: {
				...visibleTo(viewer),
				parentId: null,
				createdAt: {lte: to},
				AND: [
					{
						OR: [{finishedAt: {gte: from}}, {finishedAt: null, lastActiveAt: {gte: activeSince}}],
					},
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
			where: {...visibleTo(viewer), id: {in: ids}},
			select: taskSelect,
		}),
	);
}

/**
 * The sub-tasks of the tasks `taskIds`, at every depth, that the viewer sees, in the order started:
 * `take` of them at most, level by level, so a task with more under it than that shows what it
 * handed on itself before what those handed on in turn; of each level, the first started, or with
 * `newest`, the last, for where the newest of `taskIds` matter most.
 */
export async function listSubTasks(
	viewer: Viewer,
	taskIds: string[],
	take: number,
	{newest = false}: {newest?: boolean} = {},
): Promise<Result<AgentTaskRow[], ApiError>> {
	return wrapDb(async () => {
		const found: AgentTaskRow[] = [];
		let parentIds = taskIds;
		while (parentIds.length > 0 && found.length < take) {
			const level: AgentTaskRow[] = await db.agentTask.findMany({
				where: {...visibleTo(viewer), parentId: {in: parentIds}},
				select: taskSelect,
				orderBy: {createdAt: newest ? 'desc' : 'asc'},
				take: take - found.length,
			});
			found.push(...level);
			parentIds = level.map((task) => task.id);
		}
		return found.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
	});
}
