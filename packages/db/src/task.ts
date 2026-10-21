import type {AuditVia} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';
import {TASK_ABANDONED_AFTER_MS} from '@proxy/utils/tasks';

import {db} from '.';

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
 * Starts a task for the agent: what it is called and what the person asked for, and the task it
 * is a sub-task of, where it is one.
 */
export async function createAgentTask(data: {
	orgId: string;
	agentId: string;
	parentId: string | null;
	title: string;
	goal: string;
	via: AuditVia;
}): Promise<Result<AgentTaskRow, ApiError>> {
	return wrapDb(() => db.agentTask.create({data, select: taskSelect}));
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
 * The organization's task, whichever of its agents started it, for starting a sub-task of it.
 * `Ok(null)` means the organization has no such task.
 */
export async function getOrgTask(
	orgId: string,
	taskId: string,
): Promise<Result<AgentTaskRow | null, ApiError>> {
	return wrapDb(() => db.agentTask.findFirst({where: {id: taskId, orgId}, select: taskSelect}));
}

/**
 * Marks the agent's task finished now, with what was done where the agent said, and its sub-tasks
 * still under way finished with it, whoever's they are, since they were started for it; one
 * already finished keeps the time it was and what was said. `Ok(null)` means the agent has no such
 * task.
 */
export async function finishAgentTask(
	orgId: string,
	agentId: string,
	taskId: string,
	outcome: string | null,
): Promise<Result<AgentTaskRow | null, ApiError>> {
	return wrapDb(async () => {
		const finishedAt = new Date();
		const {count} = await db.agentTask.updateMany({
			where: {id: taskId, orgId, agentId, finishedAt: null},
			data: {finishedAt, outcome},
		});
		if (count > 0) {
			await finishSubTasks(orgId, [taskId], finishedAt);
		}
		return db.agentTask.findFirst({where: {id: taskId, orgId, agentId}, select: taskSelect});
	});
}

// Finishes the open sub-tasks of `parentIds`, level by level down the tree, at `finishedAt`.
async function finishSubTasks(orgId: string, parentIds: string[], finishedAt: Date): Promise<void> {
	const open = await db.agentTask.findMany({
		where: {orgId, parentId: {in: parentIds}, finishedAt: null},
		select: {id: true},
	});
	if (open.length === 0) {
		return;
	}
	const ids = open.map((task) => task.id);
	await db.agentTask.updateMany({where: {id: {in: ids}}, data: {finishedAt}});
	await finishSubTasks(orgId, ids, finishedAt);
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
 * The organization's tasks under way at some point since `from`: started before now and not
 * finished before `from`, nor abandoned before it, a day after it started; the newest `take` of
 * them, newest first.
 */
export async function listAgentTasksSince(
	orgId: string,
	from: Date,
	take: number,
): Promise<Result<AgentTaskRow[], ApiError>> {
	return wrapDb(() =>
		db.agentTask.findMany({
			where: {
				orgId,
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

/** The organization's tasks among `ids`, for naming what the activity log's entries were for. */
export async function listAgentTasks(
	orgId: string,
	ids: string[],
): Promise<Result<AgentTaskRow[], ApiError>> {
	if (ids.length === 0) {
		return wrapDb(async () => []);
	}
	return wrapDb(() => db.agentTask.findMany({where: {orgId, id: {in: ids}}, select: taskSelect}));
}
