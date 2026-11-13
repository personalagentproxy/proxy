import {Err, type Result} from 'ts-results-es';

import {type ApiError, ApiErr, Do, requirePresent} from '@proxy/utils';
import {taskEndedLongAgo} from '@proxy/utils/tasks';
import type {ThreadRow} from '@proxy/db/harness';

import {taskFor} from './thread-rules';
import type {HarnessStore} from './store';

/**
 * The task a thread's calls are made for, as every agent's calls are, so the activity log says
 * which piece of work each request was for. It is the member's, as the chat the thread is of is,
 * so what its agent did is theirs alone to see. A thread starts with one, made as the member's
 * message opens it (thread-rules.ts threadOpening). It is finished each time the thread's turn
 * ends, and under way again once a reply or an alert takes the thread up (db/harness). One left
 * open, as when the thread slept a while, is taken up again by its next call, unless it was left
 * open more than 20 minutes before, as when it slept long (@proxy/utils/tasks); that one, and one
 * finished by pap.finishTask from the agent's login elsewhere while the thread is still at work,
 * is replaced with a new one for the same piece of work, the title and goal the one before had,
 * once the thread makes a call again, since the gate refuses calls for it and the thread starts
 * no task of its own (tool-surface). A chat has none: it runs no turns.
 */

/** What a thread's task needs of the store. */
export type ThreadTaskStore = Pick<HarnessStore, 'getAgentTask' | 'createAgentTask' | 'setThreadTask'>;

/** The thread's task, not finished nor left open long ago: the one it has, or a new one in its place. */
export function ensureThreadTask(store: ThreadTaskStore, thread: ThreadRow): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (thread.taskId === null) {
			return $(Err(ApiErr.conflict('A chat runs no turns, so makes no calls')));
		}
		const task = $(requirePresent($(await store.getAgentTask(thread.orgId, thread.agentId, thread.taskId)), ApiErr.notFound('task', thread.taskId)));
		if (task.finishedAt === null && !taskEndedLongAgo(task, new Date())) {
			return task.id;
		}
		const made = $(await store.createAgentTask(taskFor(thread, {title: task.title, goal: task.goal})));
		const id = $(requirePresent(made, ApiErr.internalError(new Error('A task with no parent was not made')))).id;
		$(await store.setThreadTask(thread.id, id));
		return id;
	});
}
