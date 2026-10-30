import {useParams} from 'react-router';

/** The task the page is on, from its address; empty on a page that isn't any task's. */
export function useTaskId(): string {
	return useParams().taskId ?? '';
}
