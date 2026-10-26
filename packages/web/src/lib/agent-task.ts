import type {FetchError} from '@proxy/utils';
import {useParams} from 'react-router';

// The task the pages are on is in their address, `/agent/<task>/<connection>/<collection>/…`, as
// the MCP server's calls carry `task`: every run a page makes is for it, so the activity log says
// what each request was for. An agent can have any number of tasks under way, each tab on its
// own; the task list, `/agent`, opens one or starts another.

// Where the agent's tasks are listed and started, and where it is sent without one.
export const TASKS_PATH = '/agent';

/** A task's own pages start here: `/agent/<task>`. */
export function taskHome(taskId: string): string {
	return `${TASKS_PATH}/${encodeURIComponent(taskId)}`;
}

/** Where an agent is sent when the api refused its task: its tasks, saying which was refused. */
export function taskRefusedPath(taskId: string): string {
	return `${TASKS_PATH}?${new URLSearchParams({refused: taskId})}`;
}

/** The task the page is on, from its address; empty on a page that isn't any task's. */
export function useTaskId(): string {
	return useParams().taskId ?? '';
}

/**
 * The api refused a run for its task, not for anything else about it: the task is unknown (404 for
 * a `task`), or finished or left open (409). The pages send the agent back to its tasks.
 */
export function isTaskRefusal(error: FetchError): boolean {
	if (error.kind !== 'http') {
		return false;
	}
	if (error.status === 409) {
		return true;
	}
	const body = error.body;
	return (
		error.status === 404 &&
		typeof body === 'object' &&
		body !== null &&
		'resource' in body &&
		body.resource === 'task'
	);
}
