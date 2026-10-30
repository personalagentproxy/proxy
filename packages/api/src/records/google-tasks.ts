import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';

import {callGoogle} from '../connections/google/google-client';
import {getTask, getTaskList, insertTask, listTaskLists, listTasks, moveTask, patchTask, type Task, type TaskList, type TaskStatus, type TaskWrite} from '../connections/google/tasks-api';
import {realDay} from './calendar-time';
import {requireFirstPage, type CommandRunner, type DataRecord, type ListQuery, type RecordPage, type RecordStore, type RecordTarget, type RecordValues} from './connector';

/**
 * Google Tasks as the nested `tasks` collection, fetched live: at the top the account's task lists,
 * and inside each its tasks, subtasks among them, in Google's own order, 50 to a page
 * with Google's own page token, all of them or narrowed to those still to do or done.
 *
 * A list's record id is Google's list id; a task's is its list's and its own, `MTU…:dGFz…`, since a
 * task is only found in its list. A due date is a day alone, as Google Tasks keeps no time of day.
 * A task is made at the top of the list it is made in, the default list unless another is named,
 * completed and reopened by its commands, and moved to another list by writing that list's name.
 * Tasks and lists are never deleted here, and lists are only read.
 */

// Google's ids for lists and tasks; never a colon, which ends a task's list.
const ID = /^[A-Za-z0-9_+/=-]{1,300}$/;

const NEVER = new Date(0).toISOString();

// Google's own name for the account's default list, which a task made outside any list goes in.
const DEFAULT_LIST = '@default';

type TaskRef = {listId: string; taskId: string};

function taskRecordId(listId: string, taskId: string): string {
	return `${listId}:${taskId}`;
}

function parseTaskRef(recordId: string): TaskRef | null {
	const colon = recordId.lastIndexOf(':');
	const listId = recordId.slice(0, colon);
	const taskId = recordId.slice(colon + 1);
	if (colon < 0 || !ID.test(listId) || !ID.test(taskId)) {
		return null;
	}
	return {listId, taskId};
}

function requireTaskRef(recordId: string): Result<TaskRef, ApiError> {
	const ref = parseTaskRef(recordId);
	if (!ref) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(ref);
}

// A list opened inside a record, or a task made in one, is in a list: tasks hold nothing here.
function requireListId(recordId: string): Result<string, ApiError> {
	if (parseTaskRef(recordId)) {
		return Err(ApiErr.validationError('Tasks hold nothing: give a list’s id as parent'));
	}
	if (!ID.test(recordId)) {
		return Err(ApiErr.notFound('record', recordId));
	}
	return Ok(recordId);
}

// Google says a list or task that isn't there is missing; the agent asked for a record.
function notFoundAs(recordId: string) {
	return (error: ApiError): ApiError => (error.kind === 'not_found' ? ApiErr.notFound('record', recordId) : error);
}

function requireList(token: string, listId: string): Promise<Result<TaskList, ApiError>> {
	return getTaskList(token, listId).then((list) => list.mapErr(notFoundAs(listId)));
}

// A task deleted in Google Tasks is gone, though Google may still answer for it.
function requireTask(token: string, ref: TaskRef, recordId: string): Promise<Result<Task, ApiError>> {
	return Do(async ($) => {
		const task = $((await getTask(token, ref.listId, ref.taskId)).mapErr(notFoundAs(recordId)));
		if (task.deleted) {
			return $(Err(ApiErr.notFound('record', recordId)));
		}
		return task;
	});
}

function listTitle(list: TaskList): string {
	return list.title ?? list.id;
}

function listRecord(list: TaskList): DataRecord {
	return {id: list.id, values: {title: listTitle(list), kind: 'List'}, updatedAt: list.updated ?? NEVER, hasChildren: true};
}

// A subtask is under a task: by its title where it is known, else by its record id.
function taskValues(task: Task, list: TaskList, parentTitle: string): RecordValues {
	return {
		title: task.title ?? '',
		kind: 'Task',
		notes: task.notes ?? '',
		due: task.due?.slice(0, 10) ?? '',
		list: listTitle(list),
		status: task.status === 'completed' ? 'Done' : 'Needs action',
		completed: task.completed ?? '',
		subtaskOf: task.parent ? parentTitle || taskRecordId(list.id, task.parent) : '',
		source: task.links?.find((link) => link.link)?.link ?? '',
	};
}

function taskRecord(task: Task, list: TaskList, parentTitle = ''): DataRecord {
	return {id: taskRecordId(list.id, task.id), values: taskValues(task, list, parentTitle), updatedAt: task.updated ?? NEVER, ...(task.webViewLink ? {url: task.webViewLink} : {})};
}

// The title of the task a subtask is under, read from Google; none where it can't be.
async function parentTitleOf(token: string, listId: string, task: Task): Promise<string> {
	if (!task.parent) {
		return '';
	}
	const parent = await getTask(token, listId, task.parent);
	return parent.isOk() ? (parent.value.title ?? '') : '';
}

const STATUSES: Partial<Record<string, TaskStatus>> = {'Needs action': 'open', Done: 'done'};

/** The task lists, or a page of one list's tasks, narrowed to those still to do or done. */
function listTasksTree(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			if (query.parent === null) {
				$(requireFirstPage(query));
				return {records: $(await listTaskLists(token)).map(listRecord), nextPage: null};
			}
			const list = $(await requireList(token, $(requireListId(query.parent))));
			const page = $(await listTasks(token, list.id, {status: STATUSES[query.filter ?? ''] ?? null, page: query.page}));
			const tasks = page.tasks.filter((task) => !task.deleted);
			const titles = new Map(tasks.map((task) => [task.id, task.title ?? '']));
			return {
				records: tasks.map((task) => taskRecord(task, list, titles.get(task.parent ?? '') ?? '')),
				nextPage: page.nextPage,
				trail: [{id: list.id, title: listTitle(list)}],
			};
		}),
	);
}

function getTasksRecord(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const ref = parseTaskRef(recordId);
			if (!ref) {
				return listRecord($(await requireList(token, $(requireListId(recordId)))));
			}
			const task = $(await requireTask(token, ref, recordId));
			const list = $(await requireList(token, ref.listId));
			return taskRecord(task, list, await parentTitleOf(token, ref.listId, task));
		}),
	);
}

function parseDue(text: string): Result<string | null, ApiError> {
	const trimmed = text.trim();
	if (trimmed === '') {
		return Ok(null);
	}
	if (!realDay(trimmed)) {
		return Err(ApiErr.validationError(`Write due as a day, 2026-10-15, since Google Tasks keeps no time of day, not “${trimmed}”`));
	}
	return Ok(`${trimmed}T00:00:00.000Z`);
}

function requireTitle(text: string | undefined): Result<string, ApiError> {
	const title = (text ?? '').trim();
	if (title === '') {
		return Err(ApiErr.validationError('A task needs a title'));
	}
	return Ok(title);
}

// The list written by its name, or its id, among the account's lists.
function requireNamedList(token: string, name: string): Promise<Result<TaskList, ApiError>> {
	return Do(async ($) => {
		const lists = $(await listTaskLists(token));
		const wanted = name.trim().toLowerCase();
		const found = lists.find((list) => list.id === name.trim()) ?? lists.find((list) => listTitle(list).toLowerCase() === wanted);
		if (!found) {
			return $(Err(ApiErr.validationError(`No task list is called “${name.trim()}”: write one of ${lists.map(listTitle).join(', ')}`)));
		}
		return found;
	});
}

// The list a new task goes in: the one it is made inside, else the one named, else the default.
function listForNew(token: string, values: RecordValues, parent: string | null): Promise<Result<TaskList, ApiError>> {
	return Do(async ($) => {
		if (parent !== null) {
			return $(await requireList(token, $(requireListId(parent))));
		}
		if ((values.list ?? '').trim() !== '') {
			return $(await requireNamedList(token, values.list ?? ''));
		}
		return $(await requireList(token, DEFAULT_LIST));
	});
}

/** A task at the top of the list given, or the one named, or the default list. */
function createTask(target: RecordTarget, values: RecordValues, parent: string | null): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const title = $(requireTitle(values.title));
			const due = $(parseDue(values.due ?? ''));
			const list = $(await listForNew(token, values, parent));
			const notes = values.notes?.trim() ? values.notes : undefined;
			const made = $(await insertTask(token, list.id, {title, ...(notes ? {notes} : {}), ...(due ? {due} : {})}));
			return taskRecord(made, list);
		}),
	);
}

/** Changes what was written differently: the title, notes and due date, and the list, which moves the task there. */
function updateTask(target: RecordTarget, recordId: string, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return callGoogle(target.connection, (token) =>
		Do(async ($) => {
			const ref = $(requireTaskRef(recordId));
			const task = $(await requireTask(token, ref, recordId));
			const list = $(await requireList(token, ref.listId));
			const before = taskValues(task, list, '');
			const changed = (key: string) => (values[key] ?? '').trim() !== (before[key] ?? '').trim();
			const changes: TaskWrite = {};
			if (changed('title')) {
				changes.title = $(requireTitle(values.title));
			}
			if (changed('notes')) {
				changes.notes = values.notes ?? '';
			}
			if (changed('due')) {
				changes.due = $(parseDue(values.due ?? ''));
			}
			const destination = changed('list') ? $(await requireNamedList(token, values.list ?? '')) : list;
			const written = Object.keys(changes).length > 0 ? $((await patchTask(token, ref.listId, ref.taskId, changes)).mapErr(notFoundAs(recordId))) : task;
			if (destination.id === list.id) {
				return taskRecord(written, list, await parentTitleOf(token, list.id, written));
			}
			const moved = $((await moveTask(token, ref.listId, ref.taskId, destination.id)).mapErr(notFoundAs(recordId)));
			return taskRecord(moved, destination);
		}),
	);
}

// Completes a task or opens it again; Google clears when it was completed as it is reopened.
function setStatus(status: 'needsAction' | 'completed'): CommandRunner {
	return (target, recordId) =>
		callGoogle(target.connection, (token) =>
			Do(async ($) => {
				const ref = $(requireTaskRef(recordId));
				const list = $(await requireList(token, ref.listId));
				const changes: TaskWrite = status === 'completed' ? {status} : {status, completed: null};
				const task = $((await patchTask(token, ref.listId, ref.taskId, changes)).mapErr(notFoundAs(recordId)));
				return taskRecord(task, list, await parentTitleOf(token, ref.listId, task));
			}),
		);
}

export const tasksConnector = {
	list: listTasksTree,
	get: getTasksRecord,
	create: createTask,
	update: updateTask,
	commands: {complete: setStatus('completed'), reopen: setStatus('needsAction')},
} satisfies RecordStore;
