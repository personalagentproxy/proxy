import type {IncomingHttpHeaders} from 'node:http';

import {Ok, type Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import type {SignedInAgent} from '@proxy/db/agent';
import type {AgentTaskRow} from '@proxy/db/task';

import {requireOpenTask} from '../agent-side/tasks';

/**
 * PRE-TASK CLIENTS: a failsafe for the move to tasks, to be removed once every client is on them.
 * Everything that uses it is marked `PRE-TASK CLIENTS`.
 *
 * An MCP client whose session began before every call took a task holds the tool list from then,
 * which has no `start_task`, so it can't make a call for a task. `initialize` hands out a session
 * id now, so a request without one is from a session begun before. Its calls of list_connections,
 * list_tools, read and run without a task run for none, logged as the entries from before tasks
 * are, and their answer says first that the tool list changed, so the client fetches the one with
 * start_task.
 */

const TASK_TOOLS = ['list_connections', 'list_tools', 'read', 'run'];

/** Whether a tool call is a pre-task client's: no session, and no task for a tool that takes one. */
export function isPreTaskCall(headers: IncomingHttpHeaders, name: string, args: Record<string, unknown>): boolean {
	return headers['mcp-session-id'] === undefined && TASK_TOOLS.includes(name) && (typeof args.task !== 'string' || args.task === '');
}

/** The task a call is for, still under way; none for a pre-task client's call. */
export function requireOpenTaskIfAny(agent: SignedInAgent, taskId: string | null): Promise<Result<AgentTaskRow | null, ApiError>> {
	if (taskId === null) {
		return Promise.resolve(Ok(null));
	}
	return requireOpenTask(agent, taskId);
}
