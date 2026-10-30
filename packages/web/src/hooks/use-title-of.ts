import type {ActivityTask} from '@proxy/contracts/activity';
import {useCallback} from 'react';

/**
 * The name of the task of `tasks` with an id, for a chart's request targets to say what a request
 * was made for: the same function until the tasks change, so the targets are drawn again only then.
 */
export function useTitleOf(tasks: ActivityTask[]): (taskId: string | null) => string | null {
	return useCallback(
		(taskId: string | null) => tasks.find((candidate) => candidate.id === taskId)?.title ?? null,
		[tasks],
	);
}
