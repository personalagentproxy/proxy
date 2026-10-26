import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {googleRequest, googleWrite} from './google-client';

/**
 * The Tasks v1 calls the `tasks` collection makes, and the reading of their answers: the account's
 * task lists, and the tasks in each, subtasks and those assigned from Docs and Chat among them, in
 * Google's own order.
 */

const TASKS = 'https://tasks.googleapis.com/tasks/v1';

/** The tasks a page of a list holds. */
export const TASKS_PAGE_SIZE = 50;

// Google's most, far more lists than anyone keeps.
const LISTS_SIZE = 100;

const taskListSchema = z.object({id: z.string(), title: z.string().optional(), updated: z.string().optional()});

export type TaskList = z.infer<typeof taskListSchema>;

const taskListsSchema = z.object({items: z.array(taskListSchema).optional()});

const taskSchema = z.object({
	id: z.string(),
	title: z.string().optional(),
	notes: z.string().optional(),
	// `needsAction` or `completed`.
	status: z.string().optional(),
	// A day at midnight UTC: Google Tasks keeps no time of day.
	due: z.string().optional(),
	completed: z.string().optional(),
	// The task a subtask is under.
	parent: z.string().optional(),
	updated: z.string().optional(),
	webViewLink: z.string().optional(),
	// What a task was made from, such as an email in Gmail.
	links: z.array(z.object({type: z.string().optional(), description: z.string().optional(), link: z.string().optional()})).optional(),
	deleted: z.boolean().optional(),
});

export type Task = z.infer<typeof taskSchema>;

const tasksSchema = z.object({items: z.array(taskSchema).optional(), nextPageToken: z.string().optional()});

/** What a task is written with: only what changes, on an edit; a due date of null takes it off. */
export type TaskWrite = {
	title?: string;
	notes?: string;
	due?: string | null;
	status?: 'needsAction' | 'completed';
	completed?: null;
};

/** Which of a list's tasks to list: all of them, or only those still to do or done. */
export type TaskStatus = 'open' | 'done' | null;

function listUrl(listId: string, rest = ''): URL {
	return new URL(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks${rest}`);
}

function taskUrl(listId: string, taskId: string, rest = ''): URL {
	return listUrl(listId, `/${encodeURIComponent(taskId)}${rest}`);
}

/** The account's task lists, as Google Tasks shows them. */
export async function listTaskLists(accessToken: string): Promise<Result<TaskList[], ApiError>> {
	const url = new URL(`${TASKS}/users/@me/lists`);
	url.searchParams.set('maxResults', String(LISTS_SIZE));
	const answer = await googleRequest(accessToken, url, taskListsSchema);
	return answer.map(({items = []}) => items);
}

export function getTaskList(accessToken: string, listId: string): Promise<Result<TaskList, ApiError>> {
	return googleRequest(accessToken, new URL(`${TASKS}/users/@me/lists/${encodeURIComponent(listId)}`), taskListSchema);
}

/**
 * A page of a list's tasks, in Google's order, those assigned from Docs and Chat among them, which
 * Google leaves out unless asked. Tasks completed in Google Tasks are hidden
 * there, so done ones are asked for with the hidden ones; a lower bound on when a task was
 * completed leaves out the ones still to do.
 */
export async function listTasks(accessToken: string, listId: string, args: {status: TaskStatus; page: string | null}): Promise<Result<{tasks: Task[]; nextPage: string | null}, ApiError>> {
	const url = listUrl(listId);
	url.searchParams.set('maxResults', String(TASKS_PAGE_SIZE));
	url.searchParams.set('showCompleted', String(args.status !== 'open'));
	url.searchParams.set('showHidden', String(args.status !== 'open'));
	url.searchParams.set('showAssigned', 'true');
	if (args.status === 'done') {
		url.searchParams.set('completedMin', '1970-01-01T00:00:00.000Z');
	}
	if (args.page) {
		url.searchParams.set('pageToken', args.page);
	}
	const answer = await googleRequest(accessToken, url, tasksSchema);
	return answer.map(({items = [], nextPageToken}) => ({tasks: items, nextPage: nextPageToken ?? null}));
}

export function getTask(accessToken: string, listId: string, taskId: string): Promise<Result<Task, ApiError>> {
	return googleRequest(accessToken, taskUrl(listId, taskId), taskSchema);
}

/** Makes a task at the top of a list. */
export function insertTask(accessToken: string, listId: string, task: TaskWrite): Promise<Result<Task, ApiError>> {
	return googleWrite(accessToken, 'POST', listUrl(listId), task, taskSchema);
}

/** Changes what is given of a task, the rest as it is. */
export function patchTask(accessToken: string, listId: string, taskId: string, task: TaskWrite): Promise<Result<Task, ApiError>> {
	return googleWrite(accessToken, 'PATCH', taskUrl(listId, taskId), task, taskSchema);
}

/** Moves a task to the top of another list; Google turns a repeating one down. */
export function moveTask(accessToken: string, listId: string, taskId: string, destinationListId: string): Promise<Result<Task, ApiError>> {
	const url = taskUrl(listId, taskId, '/move');
	url.searchParams.set('destinationTasklist', destinationListId);
	return googleWrite(accessToken, 'POST', url, {}, taskSchema);
}
