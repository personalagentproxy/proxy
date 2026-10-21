import type {AuditVia} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';
import {TASK_ABANDONED_AFTER_MS} from '@proxy/utils/tasks';

import {db} from '.';

/** What an agent set out to do, as it named it when it started. */
export type AgentTaskRow = {
	id: string;
	agentId: string;
	title: string;
	goal: string;
	via: AuditVia;
	createdAt: Date;
	// Null while the task is under way.
	finishedAt: Date | null;
};

const taskSelect = {
	id: true,
	agentId: true,
	title: true,
	goal: true,
	via: true,
	createdAt: true,
	finishedAt: true,
} as const;

/** Starts a task for the agent: what it is called and what the person asked for. */
export async function createAgentTask(data: {
	orgId: string;
	agentId: string;
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
 * Marks the agent's task finished now; one already finished keeps the time it was. `Ok(null)` means
 * the agent has no such task.
 */
export async function finishAgentTask(
	orgId: string,
	agentId: string,
	taskId: string,
): Promise<Result<AgentTaskRow | null, ApiError>> {
	return wrapDb(async () => {
		await db.agentTask.updateMany({
			where: {id: taskId, orgId, agentId, finishedAt: null},
			data: {finishedAt: new Date()},
		});
		return db.agentTask.findFirst({where: {id: taskId, orgId, agentId}, select: taskSelect});
	});
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
