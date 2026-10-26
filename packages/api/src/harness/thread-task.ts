import type {Result} from 'ts-results-es';

import {type ApiError, ApiErr, Do, requirePresent} from '@proxy/utils';
import {taskEndedAt} from '@proxy/utils/tasks';
import {createAgentTask, getAgentTask} from '@proxy/db/task';
import {listEntries, setThreadTask, type ThreadRow} from '@proxy/db/harness';

/**
 * The task a thread's calls are made for, as every agent's calls are, so the activity log says
 * which conversation each request was for. It is the member's, as the conversation is, so what the
 * agent did in it is theirs alone to see. A thread starts with one, and gets a new one when it was
 * abandoned, a day after it started, since the gate refuses calls for one that was.
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

// A task for the thread's calls; a sub-task of nothing, so always made.
function makeTask(thread: {orgId: string; agentId: string; userId: string}, goal: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const made = $(await createAgentTask({orgId: thread.orgId, agentId: thread.agentId, ownerUserId: thread.userId, parentId: null, title: TITLE, goal, via: 'harness'}));
		return $(requirePresent(made, ApiErr.internalError(new Error('A task with no parent was not made')))).id;
	});
}

/** A thread's first task, before it has a log. */
export function createThreadTask(thread: {orgId: string; agentId: string; userId: string}): Promise<Result<string, ApiError>> {
	return makeTask(thread, 'A conversation on the Chat page');
}

/** The thread's task, still under way: the one it has, or a new one in its place. */
export function ensureThreadTask(thread: ThreadRow, now: Date): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const task = $(await getAgentTask(thread.orgId, thread.agentId, thread.taskId));
		if (task && taskEndedAt({lastStartedAt: task.lastStartedAt, finishedAt: task.finishedAt}, now) === null) {
			return task.id;
		}
		const entries = $(await listEntries(thread.id));
		const made = $(await makeTask(thread, goalOf(entries)));
		$(await setThreadTask(thread.id, made));
		return made;
	});
}
