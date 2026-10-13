import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, type FetchError, httpRequest} from '@proxy/utils';

/**
 * TickTick's Open API, v1, as the person whose personal API token it is. Every request is made
 * once and never retried: a write TickTick didn't answer in time may still have gone through. The
 * token goes in the Authorization header alone, and nothing TickTick answers to a refused token is
 * kept, since its 401 says the token back.
 *
 * Lists are TickTick's projects. The Inbox isn't among them: `project/inbox/data` lists it, and
 * its tasks name it by its own id, `inbox` and the account's number, which works anywhere a list's
 * id does. A list's data is its open tasks; TickTick answers a list it doesn't have with `{}`.
 * Changing a task sends only what changes, and TickTick keeps the rest of it. Completing answers
 * nothing, as does changing or completing a task TickTick doesn't have, so a task is fetched first.
 */

const BASE_URL = 'https://api.ticktick.com/open/v1';
const TIMEOUT_MS = 15_000;

// The Inbox, as the Open API takes it in place of its own id.
export const INBOX_ID = 'inbox';

const projectSchema = z.object({
	id: z.string(),
	name: z.string(),
	sortOrder: z.number().nullish(),
	// Archived.
	closed: z.boolean().nullish(),
	// TASK, or NOTE for a list of notes.
	kind: z.string().nullish(),
});

const taskSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	title: z.string().nullish(),
	content: z.string().nullish(),
	// A checklist task's description; its content is unused.
	desc: z.string().nullish(),
	startDate: z.string().nullish(),
	dueDate: z.string().nullish(),
	timeZone: z.string().nullish(),
	isAllDay: z.boolean().nullish(),
	// 0, 1, 3 or 5.
	priority: z.number().nullish(),
	// 0 open, 2 completed.
	status: z.number().nullish(),
	tags: z.array(z.string()).nullish(),
	items: z.array(z.object({title: z.string().nullish(), status: z.number().nullish()})).nullish(),
	// TEXT, CHECKLIST, or NOTE for a note.
	kind: z.string().nullish(),
	modifiedTime: z.string().nullish(),
});

const projectDataSchema = z.object({
	project: projectSchema.nullish(),
	tasks: z.array(taskSchema).optional(),
});

export type TickTickProject = z.infer<typeof projectSchema>;
export type TickTickTask = z.infer<typeof taskSchema>;

/** What a task is written with; anything left out is kept as it is. */
export type TaskFields = {title?: string; content?: string; desc?: string; priority?: number};

/** A new task: in the list `projectId`, or the Inbox without one. */
export type NewTask = TaskFields & {title: string; projectId?: string};

// TickTick's error code, such as `resource_not_found`, when it sent one.
function errorCode(body: unknown): string | null {
	if (typeof body !== 'object' || body === null || !('errorCode' in body)) {
		return null;
	}
	return typeof body.errorCode === 'string' ? body.errorCode : null;
}

// What went wrong, without TickTick's own answer, which may hold the token.
function describe(error: FetchError): string {
	if (error.kind === 'http') {
		const code = errorCode(error.body);
		return `TickTick answered ${error.status}${code ? ` (${code})` : ''} to ${error.url}`;
	}
	if (error.kind === 'timeout') {
		return `TickTick didn't answer ${error.url} within ${error.timeoutMs}ms`;
	}
	if (error.kind === 'network') {
		return `TickTick couldn't be reached at ${error.url}`;
	}
	if (error.kind === 'schema') {
		return `TickTick's answer to ${error.url} wasn't as expected at ${error.issues.map((issue) => issue.path.join('.')).join(', ')}`;
	}
	return `TickTick's answer to ${error.url} wasn't JSON`;
}

/** A refused token, a task TickTick doesn't have, its rate limit, or TickTick out of reach. */
export function toApiError(error: FetchError): ApiError {
	if (error.kind === 'http' && error.status === 401) {
		return ApiErr.credentialsRejected();
	}
	if (error.kind === 'http' && error.status === 404) {
		return ApiErr.notFound('task');
	}
	if (error.kind === 'http' && error.status === 429) {
		return ApiErr.rateLimited('TickTick is turning requests away for now. Try again in a minute.');
	}
	return ApiErr.providerUnreachable(new Error(describe(error)));
}

function url(...path: string[]): string {
	return [BASE_URL, ...path.map(encodeURIComponent)].join('/');
}

function request(token: string, method: 'GET' | 'POST', body?: object): RequestInit {
	if (body === undefined) {
		return {method, headers: {Authorization: `Bearer ${token}`}};
	}
	return {method, headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)};
}

/** The account's lists, archived ones and lists of notes too; the Inbox isn't one of them. */
export async function listProjects(token: string): Promise<Result<TickTickProject[], ApiError>> {
	return (await httpRequest(url('project'), request(token, 'GET'), {schema: z.array(projectSchema), timeoutMs: TIMEOUT_MS})).mapErr(toApiError);
}

/** A list's open tasks, and the list itself where it isn't the Inbox; null for one TickTick doesn't have. */
export async function getProjectData(token: string, projectId: string): Promise<Result<{project: TickTickProject | null; tasks: TickTickTask[]} | null, ApiError>> {
	const data = await httpRequest(url('project', projectId, 'data'), request(token, 'GET'), {schema: projectDataSchema, timeoutMs: TIMEOUT_MS});
	return data.mapErr(toApiError).map(({project, tasks}) => (tasks === undefined ? null : {project: project ?? null, tasks}));
}

/** A task in a list, open or completed. */
export async function getTask(token: string, projectId: string, taskId: string): Promise<Result<TickTickTask, ApiError>> {
	return (await httpRequest(url('project', projectId, 'task', taskId), request(token, 'GET'), {schema: taskSchema, timeoutMs: TIMEOUT_MS})).mapErr(toApiError);
}

export async function createTask(token: string, task: NewTask): Promise<Result<TickTickTask, ApiError>> {
	return (await httpRequest(url('task'), request(token, 'POST', task), {schema: taskSchema, timeoutMs: TIMEOUT_MS})).mapErr(toApiError);
}

/** Changes the fields given and keeps the rest of the task. */
export async function updateTask(token: string, task: {id: string; projectId: string}, fields: TaskFields): Promise<Result<TickTickTask, ApiError>> {
	const body = {id: task.id, projectId: task.projectId, ...fields};
	return (await httpRequest(url('task', task.id), request(token, 'POST', body), {schema: taskSchema, timeoutMs: TIMEOUT_MS})).mapErr(toApiError);
}

/** Marks a task done; TickTick answers with an empty body. */
export async function completeTask(token: string, projectId: string, taskId: string): Promise<Result<void, ApiError>> {
	return (await httpRequest(url('project', projectId, 'task', taskId, 'complete'), request(token, 'POST'), {timeoutMs: TIMEOUT_MS})).mapErr(toApiError);
}

/** Whether TickTick takes the token, by listing the account's lists. */
export async function checkToken(token: string): Promise<Result<void, ApiError>> {
	return (await listProjects(token)).map(() => undefined);
}
