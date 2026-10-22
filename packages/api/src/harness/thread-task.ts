import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {taskEndedAt} from '@proxy/utils/tasks';
import {createAgentTask, getAgentTask} from '@proxy/db/task';
import {listEntries, setThreadTask, type ThreadRow} from '@proxy/db/harness';

/**
 * The task a thread's calls are made for, as every agent's calls are, so the activity log says
 * which conversation each request was for. A thread starts with one, and gets a new one when it
 * was abandoned, a day after it started, since the gate refuses calls for one that was.
 */

const TITLE = 'Chat';
const MAX_GOAL = 2000;

// What the task is for: what the person first said in the thread, as far as a goal holds.
function goalOf(entries: Array<{kind: string; text: string}>): string {
	const first = entries.find((entry) => entry.kind === 'person')?.text.trim() ?? '';
	if (first === '') {
		return 'A conversation on the Chat page';
	}
	return first.length > MAX_GOAL ? `${first.slice(0, MAX_GOAL - 1)}…` : first;
}

/** A thread's first task, before it has a log. */
export function createThreadTask(orgId: string, agentId: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => $(await createAgentTask({orgId, agentId, title: TITLE, goal: 'A conversation on the Chat page', via: 'harness'})).id);
}

/** The thread's task, still under way: the one it has, or a new one in its place. */
export function ensureThreadTask(thread: ThreadRow, now: Date): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const task = $(await getAgentTask(thread.orgId, thread.agentId, thread.taskId));
		if (task && taskEndedAt({startedAt: task.createdAt, finishedAt: task.finishedAt}, now) === null) {
			return task.id;
		}
		const entries = $(await listEntries(thread.id));
		const made = $(await createAgentTask({orgId: thread.orgId, agentId: thread.agentId, title: TITLE, goal: goalOf(entries), via: 'harness'}));
		$(await setThreadTask(thread.id, made.id));
		return made.id;
	});
}
