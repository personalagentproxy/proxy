// An agent says when it has finished a task, but it may never say so: a task still open a day
// after it, or the last of its sub-tasks at any depth, was started is taken as abandoned, ended
// then. So a task isn't given up on while a sub-agent is still at work on part of it, and a parent
// is never abandoned before any of its sub-tasks. One abandoned is no longer under way, so no call
// can be made for it; the web app shows it as having ended at the last request made for it.

export const TASK_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * When a task ended: when it was finished, or, where it never was and that is past, a day after it
 * or the last of its sub-tasks was started (`lastStartedAt`); null while it is under way.
 */
export function taskEndedAt(
	task: {lastStartedAt: Date; finishedAt: Date | null},
	now: Date,
): Date | null {
	if (task.finishedAt !== null) {
		return task.finishedAt;
	}
	const abandonedAt = new Date(task.lastStartedAt.getTime() + TASK_ABANDONED_AFTER_MS);
	return abandonedAt <= now ? abandonedAt : null;
}
