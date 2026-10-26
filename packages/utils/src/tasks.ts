// An agent says when it has finished a task, but it often doesn't: a task still open 20 minutes
// after anything was last done for it or for one of its sub-tasks at any depth, a sub-task started
// or a request made, is taken as left open, ended then. So a task isn't ended while a sub-agent is
// still at work on part of it, and a parent is never left open before any of its sub-tasks. One
// left open is no longer under way, so no call can be made for it; the web app shows it as having
// ended at the last request made for it.

export const TASK_LEFT_OPEN_AFTER_MS = 20 * 60 * 1000;

/**
 * When a task ended: when it was finished, or, where it never was and that is past, 20 minutes
 * after anything was last done for it or its sub-tasks (`lastActiveAt`); null while it is under way.
 */
export function taskEndedAt(
	task: {lastActiveAt: Date; finishedAt: Date | null},
	now: Date,
): Date | null {
	if (task.finishedAt !== null) {
		return task.finishedAt;
	}
	const leftOpenAt = new Date(task.lastActiveAt.getTime() + TASK_LEFT_OPEN_AFTER_MS);
	return leftOpenAt <= now ? leftOpenAt : null;
}
