import {Err, type Result} from 'ts-results-es';

import {type ApiError, ApiErr, Do, requirePresent} from '@proxy/utils';
import {taskEndedAt} from '@proxy/utils/tasks';
import {createAgentTask, getAgentTask} from '@proxy/db/task';
import {setThreadTask, type ThreadRow} from '@proxy/db/harness';

/**
 * The task a sub-agent's calls are made for, as every agent's calls are, so the activity log says
 * which piece of work each request was for. It is the member's, as the conversation it was
 * delegated from is, so what the sub-agent did is theirs alone to see. A sub-agent starts with
 * one, made as it is (db/harness startSubAgent), and gets a new one when it was abandoned, a day
 * after it started, as when it slept long, since the gate refuses calls for one that was, for the
 * same piece of work, the title and goal the one before had. The agent talking with the person has
 * none: it makes no calls but to delegate.
 */

/** The sub-agent's task, still under way: the one it has, or a new one in its place. */
export function ensureThreadTask(thread: ThreadRow, now: Date): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (thread.taskId === null) {
			return $(Err(ApiErr.conflict('The agent talking with the person makes no calls of its own')));
		}
		const task = $(requirePresent($(await getAgentTask(thread.orgId, thread.agentId, thread.taskId)), ApiErr.notFound('task', thread.taskId)));
		if (taskEndedAt({lastStartedAt: task.lastStartedAt, finishedAt: task.finishedAt}, now) === null) {
			return task.id;
		}
		const made = $(
			await createAgentTask({
				orgId: thread.orgId,
				agentId: thread.agentId,
				ownerUserId: thread.userId,
				personaId: thread.personaId,
				parentId: null,
				title: task.title,
				goal: task.goal,
				via: 'harness',
			}),
		);
		const id = $(requirePresent(made, ApiErr.internalError(new Error('A task with no parent was not made')))).id;
		$(await setThreadTask(thread.id, id));
		return id;
	});
}
