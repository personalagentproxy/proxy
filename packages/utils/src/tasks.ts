// An agent says when it has finished a task, but it may never say so: a task still open a day
// after it started is taken as abandoned, ended then. It is no longer under way, so no call can be
// made for it, and the home page's lanes end its bar there.

export const TASK_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/** When a task ended: when it was finished, or a day after it started where it never was and that is past; null while it is under way. */
export function taskEndedAt(
	task: {startedAt: Date; finishedAt: Date | null},
	now: Date,
): Date | null {
	if (task.finishedAt !== null) {
		return task.finishedAt;
	}
	const abandonedAt = new Date(task.startedAt.getTime() + TASK_ABANDONED_AFTER_MS);
	return abandonedAt <= now ? abandonedAt : null;
}
