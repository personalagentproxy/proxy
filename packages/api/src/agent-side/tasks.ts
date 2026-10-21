import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {taskEndedAt} from '@proxy/utils/tasks';
import type {SignedInAgent} from '@proxy/db/agent';
import {type AgentTaskRow, createAgentTask, finishAgentTask as markAgentTaskFinished, getAgentTask, listOpenAgentTasks} from '@proxy/db/task';

import type {AgentCaller} from './tools';

/**
 * Tasks: what an agent set out to do with Personal Agent Proxy. Before anything else, an agent
 * starts one, naming it and saying what the person asked for; it gives the task's id with every
 * call it makes, which the activity log keeps with the request; and it finishes the task when it is
 * done, saying what it did where it says. So the person can see which request was made for what.
 * An agent can have any number of tasks under way at once, each with calls of its own.
 *
 * When an agent splits a task among sub-agents of its own, which sign in as it does, it starts a
 * sub-task for each part, with the task as its parent, so the tasks of one job form a tree the
 * person can follow. The parent is one of the agent's own tasks still under way. Finishing a task
 * finishes its sub-tasks still under way too.
 */

const MAX_TITLE = 120;
const MAX_GOAL = 2000;
const MAX_OUTCOME = 2000;

const startSchema = z.object({title: z.string(), goal: z.string(), parent: z.string().optional()});
const finishSchema = z.object({task: z.string(), outcome: z.string().optional()});

/**
 * A task as an agent sees it: `task` is its id, which every other call takes; `parent` the task it
 * is a sub-task of, or null; `outcome` what was done, once finished with one.
 */
export type AgentTaskResponse = {task: string; parent: string | null; title: string; goal: string; startedAt: string; finishedAt: string | null; outcome: string | null};

function toResponse(task: AgentTaskRow): AgentTaskResponse {
	return {
		task: task.id,
		parent: task.parentId,
		title: task.title,
		goal: task.goal,
		startedAt: task.createdAt.toISOString(),
		finishedAt: task.finishedAt?.toISOString() ?? null,
		outcome: task.outcome,
	};
}

/**
 * Starts a task for the agent: `{title, goal}`, both trimmed and neither empty, and `parent` where
 * it is a sub-task, the id of one of the agent's tasks still under way.
 */
export function startAgentTask(caller: AgentCaller, args: unknown): Promise<Result<AgentTaskResponse, ApiError>> {
	return Do(async ($) => {
		const parsed = $(parseSchema(startSchema, args));
		const title = parsed.title.trim();
		const goal = parsed.goal.trim();
		if (title === '') {
			return $(Err(ApiErr.validationError('The task needs a title: what it is, in a few words.')));
		}
		if (title.length > MAX_TITLE) {
			return $(Err(ApiErr.validationError(`The title is ${title.length} characters long; keep it under ${MAX_TITLE}, a few words.`)));
		}
		if (goal === '') {
			return $(Err(ApiErr.validationError('The task needs a goal: what the person asked for, in a sentence or two.')));
		}
		if (goal.length > MAX_GOAL) {
			return $(Err(ApiErr.validationError(`The goal is ${goal.length} characters long; keep it under ${MAX_GOAL}, a sentence or two.`)));
		}
		const parentId = parsed.parent?.trim() || null;
		if (parentId !== null) {
			$(await requireOpenTask(caller.agent, parentId));
		}
		const task = $(await createAgentTask({orgId: caller.agent.orgId, agentId: caller.agent.agentId, parentId, title, goal, via: caller.via}));
		// Only where the parent was finished, or abandoned, since it was checked above.
		if (task === null) {
			return $(Err(ApiErr.conflict(`Task ${parentId} is no longer under way. Start a new task for what you are doing now, and give its id as task.`)));
		}
		return toResponse(task);
	});
}

/** The agent's tasks still under way, newest first. */
export function listAgentOpenTasks(agent: SignedInAgent): Promise<Result<{tasks: AgentTaskResponse[]}, ApiError>> {
	return Do(async ($) => ({tasks: $(await listOpenAgentTasks(agent.orgId, agent.agentId)).map(toResponse)}));
}

/** The agent's task `taskId` while it is under way, refused as a call made for it would be (`requireOpenTask`). */
export function getAgentOpenTask(agent: SignedInAgent, taskId: string): Promise<Result<AgentTaskResponse, ApiError>> {
	return Do(async ($) => toResponse($(await requireOpenTask(agent, taskId))));
}

/**
 * Marks the agent's task `{task}` finished, with `outcome`, what was done or found, where the
 * agent gives one; its sub-tasks still under way are finished with it. One finished already keeps
 * when it was, taking the outcome only where it has none, such as a sub-task finished with its
 * parent; one abandoned (@proxy/utils/tasks) can't be finished any more, and is refused as a
 * conflict.
 */
export function finishAgentTask(caller: AgentCaller, args: unknown): Promise<Result<AgentTaskResponse, ApiError>> {
	return Do(async ($) => {
		const {task: taskId, outcome: given} = $(parseSchema(finishSchema, args));
		const outcome = given?.trim() || null;
		if (outcome !== null && outcome.length > MAX_OUTCOME) {
			return $(Err(ApiErr.validationError(`The outcome is ${outcome.length} characters long; keep it under ${MAX_OUTCOME}, a sentence or two.`)));
		}
		const task = $(requirePresent($(await markAgentTaskFinished(caller.agent.orgId, caller.agent.agentId, taskId, outcome)), ApiErr.notFound('task', taskId)));
		if (task.finishedAt === null) {
			return $(Err(ApiErr.conflict(`Task ${taskId} (${task.title}) was started over a day ago and never finished, so it is taken as abandoned, and ended then.`)));
		}
		return toResponse(task);
	});
}

/**
 * The agent's task `taskId` for a call made for it; unknown, or another agent's, is not found. One
 * finished already, or abandoned (@proxy/utils/tasks), is refused as a conflict, saying to start a
 * new one, so the agent pages can tell it from any other refusal of the call.
 */
export function requireOpenTask(agent: SignedInAgent, taskId: string): Promise<Result<AgentTaskRow, ApiError>> {
	return Do(async ($) => {
		const task = $(requirePresent($(await getAgentTask(agent.orgId, agent.agentId, taskId)), ApiErr.notFound('task', taskId)));
		if (task.finishedAt !== null) {
			return $(Err(ApiErr.conflict(`Task ${taskId} (${task.title}) is finished. Start a new task for what you are doing now, and give its id as task.`)));
		}
		if (taskEndedAt({startedAt: task.createdAt, finishedAt: null}, new Date()) !== null) {
			return $(
				Err(
					ApiErr.conflict(
						`Task ${taskId} (${task.title}) was started over a day ago and never finished, so it is taken as abandoned. Start a new task for what you are doing now, and give its id as task.`,
					),
				),
			);
		}
		return task;
	});
}
