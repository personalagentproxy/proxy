import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {TICKTICK_PRIORITIES} from '@proxy/integrations';

import {ticktickCredentialSchema} from '../connections/ticktick/credential';
import {completeTask, createTask, getProjectData, getTask, INBOX_ID, listProjects, updateTask, type TaskFields, type TickTickProject, type TickTickTask} from '../connections/ticktick/ticktick-api';
import {decryptSecret} from '../utils/secret-crypto';
import type {Connector, DataRecord, ListQuery, RecordPage, RecordTarget, RecordValues} from './connector';

/**
 * A TickTick account's tasks, fetched live from TickTick's Open API with the connection's token.
 * The top is the Inbox, then the lists in TickTick's own order; inside a list are its open tasks,
 * the ones changed last first, 50 to a page. TickTick's Open API has no paging and its search
 * misses tasks, so a list is fetched whole and searched here, in task titles and notes, or, at the
 * top, list names. Lists of notes, and notes, are left out.
 *
 * Ids say what they are: `project:<list>` for a list, the Inbox `project:inbox`, and
 * `task:<list>:<task>` for a task, by the list TickTick has it in. A task is added in a list,
 * edited with only the fields written differently, and completed by the command alone: editing
 * never changes its status. Tasks aren't deleted.
 */

const PAGE_SIZE = 50;

// TickTick's numbers for the catalog's priorities, in the same order.
const PRIORITY_VALUES = [0, 1, 3, 5];

// TickTick's ids: 24 hex digits, or `inbox` and the account's number.
const ID = /^[A-Za-z0-9]{1,64}$/;

type RecordRef = {kind: 'list'; projectId: string} | {kind: 'task'; projectId: string; taskId: string};

function parseRecordId(recordId: string): RecordRef | null {
	const parts = recordId.split(':');
	if (!parts.every((part) => ID.test(part))) {
		return null;
	}
	const [kind, projectId, taskId] = parts;
	if (kind === 'project' && projectId && parts.length === 2) {
		return {kind: 'list', projectId};
	}
	if (kind === 'task' && projectId && taskId && parts.length === 3) {
		return {kind: 'task', projectId, taskId};
	}
	return null;
}

function listId(projectId: string): string {
	return `project:${projectId}`;
}

function taskId(task: TickTickTask): string {
	return `task:${task.projectId}:${task.id}`;
}

function notFound(recordId: string): ApiError {
	return ApiErr.notFound('record', recordId);
}

function tokenOf(target: RecordTarget): Result<string, ApiError> {
	return Do<string, ApiError>(($) => {
		const stored = $(requirePresent(target.connection.credential, ApiErr.internalError(new Error('The connection has no credential'))));
		const json = $(decryptSecret(stored));
		const parsed = $(Result.wrap((): unknown => JSON.parse(json)).mapErr((cause) => ApiErr.internalError(cause)));
		return $(parseSchema(ticktickCredentialSchema, parsed)).token;
	});
}

function isInbox(projectId: string): boolean {
	return projectId.startsWith(INBOX_ID);
}

// Lists of notes hold notes rather than tasks.
function isTaskList(project: TickTickProject): boolean {
	return project.kind !== 'NOTE';
}

function isTask(task: TickTickTask): boolean {
	return task.kind !== 'NOTE';
}

function priorityName(value: number | null | undefined): string {
	return TICKTICK_PRIORITIES[PRIORITY_VALUES.indexOf(value ?? 0)] ?? 'None';
}

function priorityValue(name: string): number {
	return PRIORITY_VALUES[TICKTICK_PRIORITIES.indexOf(name)] ?? 0;
}

// TickTick's "2026-10-20T08:00:00.000+0000", which JavaScript reads with a colon in the offset.
function parseTime(value: string): Date | null {
	const date = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
	return Number.isNaN(date.getTime()) ? null : date;
}

function validZone(timeZone: string | null | undefined): string {
	if (!timeZone) {
		return 'UTC';
	}
	return Result.wrap(() => new Intl.DateTimeFormat('en-US', {timeZone})).isOk() ? timeZone : 'UTC';
}

// In the task's time zone: the day alone for a task of a whole day, "2026-10-20", else the time
// too, "2026-10-20 09:00 (Europe/Berlin)".
function dateText(value: string | null | undefined, task: TickTickTask): string {
	const date = value ? parseTime(value) : null;
	if (!value || !date) {
		return value ?? '';
	}
	const zone = validZone(task.timeZone);
	const format = new Intl.DateTimeFormat('en-US', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
	const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
	const day = `${parts.year}-${parts.month}-${parts.day}`;
	return task.isAllDay ? day : `${day} ${parts.hour}:${parts.minute} (${zone})`;
}

function updatedText(task: TickTickTask): string {
	const date = task.modifiedTime ? parseTime(task.modifiedTime) : null;
	return date ? date.toISOString() : '';
}

// The notes a task is written with: a checklist task's description, else its content.
function contentKey(task: TickTickTask): 'desc' | 'content' {
	return task.kind === 'CHECKLIST' ? 'desc' : 'content';
}

function checklistText(task: TickTickTask): string {
	return (task.items ?? []).map((item) => `[${item.status === 1 ? 'x' : ' '}] ${item.title ?? ''}`).join('\n');
}

function taskValues(task: TickTickTask, list: string): RecordValues {
	return {
		title: task.title ?? '',
		kind: 'Task',
		status: task.status === 2 ? 'Completed' : 'Open',
		list,
		priority: priorityName(task.priority),
		startDate: dateText(task.startDate, task),
		dueDate: dateText(task.dueDate, task),
		tags: (task.tags ?? []).join(', '),
		checklist: checklistText(task),
		link: `https://ticktick.com/webapp/#p/${task.projectId}/tasks/${task.id}`,
		updated: updatedText(task),
		content: task[contentKey(task)] ?? '',
	};
}

function taskRecord(task: TickTickTask, list: string): DataRecord {
	return {id: taskId(task), values: taskValues(task, list), updatedAt: updatedText(task)};
}

function listRecord(projectId: string, name: string): DataRecord {
	return {id: listId(projectId), values: {title: name, kind: 'List'}, updatedAt: '', hasChildren: true};
}

const INBOX_RECORD = listRecord(INBOX_ID, 'Inbox');

// Every word somewhere in the text, in any case.
function matches(search: string | null, ...texts: (string | null | undefined)[]): boolean {
	if (search === null) {
		return true;
	}
	const text = texts.join('\n').toLowerCase();
	return search
		.toLowerCase()
		.split(/\s+/)
		.every((word) => text.includes(word));
}

function pageOf(records: DataRecord[], page: string | null): Result<RecordPage, ApiError> {
	const offset = Number(page ?? 0);
	if (!Number.isInteger(offset) || offset < 0) {
		return Err(ApiErr.validationError('Not a page of TickTick tasks'));
	}
	const next = offset + PAGE_SIZE;
	return Ok({records: records.slice(offset, next), nextPage: next < records.length ? String(next) : null});
}

// The lists at the top: the Inbox, then the lists of tasks in TickTick's order, archived ones left
// out as TickTick hides them.
function listLists(token: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const projects = $(await listProjects(token))
			.filter((project) => isTaskList(project) && !project.closed)
			.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
		const records = [INBOX_RECORD, ...projects.map((project) => listRecord(project.id, project.name))].filter((record) => matches(query.search, record.values.title));
		return $(pageOf(records, query.page));
	});
}

// A list's name, the Inbox's too, or not found.
function listName(token: string, projectId: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (isInbox(projectId)) {
			return 'Inbox';
		}
		const project = (await listProjects(token)).map((projects) => projects.find((candidate) => candidate.id === projectId && isTaskList(candidate)));
		return $(requirePresent($(project), notFound(listId(projectId)))).name;
	});
}

function listTasks(token: string, parent: string, projectId: string, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const data = $(requirePresent($(await getProjectData(token, projectId)), notFound(parent)));
		const name = isInbox(projectId) ? 'Inbox' : (data.project?.name ?? $(await listName(token, projectId)));
		const records = data.tasks
			.filter((task) => isTask(task) && task.status !== 2 && matches(query.search, task.title, task.content, task.desc))
			.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''))
			.map((task) => taskRecord(task, name));
		const page = $(pageOf(records, query.page));
		return {...page, trail: [{id: parent, title: name}]};
	});
}

function list(target: RecordTarget, query: ListQuery): Promise<Result<RecordPage, ApiError>> {
	return Do(async ($) => {
		const token = $(tokenOf(target));
		if (query.parent === null) {
			return $(await listLists(token, query));
		}
		const ref = $(requirePresent(parseRecordId(query.parent), notFound(query.parent)));
		if (ref.kind === 'task') {
			return $(Err(ApiErr.validationError('A task holds no other tasks here: list a list’s tasks with its id as parent')));
		}
		return $(await listTasks(token, query.parent, ref.projectId, query));
	});
}

// A task TickTick has, and not a note, with the name of its list.
function fetchTask(token: string, recordId: string, ref: {projectId: string; taskId: string}): Promise<Result<{task: TickTickTask; list: string}, ApiError>> {
	return Do(async ($) => {
		const [task, list] = await Promise.all([getTask(token, ref.projectId, ref.taskId), listName(token, ref.projectId)]);
		const found = $(task.mapErr((error) => (error.kind === 'not_found' ? notFound(recordId) : error)));
		if (!isTask(found)) {
			return $(Err(notFound(recordId)));
		}
		return {task: found, list: $(list)};
	});
}

function requireTask(recordId: string, what: string): Result<{projectId: string; taskId: string}, ApiError> {
	const ref = parseRecordId(recordId);
	if (!ref) {
		return Err(notFound(recordId));
	}
	if (ref.kind === 'list') {
		return Err(ApiErr.validationError(`Lists aren't ${what} here, only the tasks in them`));
	}
	return Ok(ref);
}

function get(target: RecordTarget, recordId: string): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const token = $(tokenOf(target));
		const ref = $(requirePresent(parseRecordId(recordId), notFound(recordId)));
		if (ref.kind === 'list' && ref.projectId === INBOX_ID) {
			return INBOX_RECORD;
		}
		if (ref.kind === 'list') {
			return listRecord(ref.projectId, $(await listName(token, ref.projectId)));
		}
		const {task, list} = $(await fetchTask(token, recordId, ref));
		return taskRecord(task, list);
	});
}

// The Inbox's own id, from its tasks: TickTick names it by its id. Without a task to read it from,
// a new task is sent without a list, which TickTick puts in the Inbox.
function inboxId(token: string): Promise<Result<string | undefined, ApiError>> {
	return Do(async ($) => {
		const data = $(await getProjectData(token, INBOX_ID));
		return data?.tasks[0]?.projectId;
	});
}

function title(value: string): Result<string, ApiError> {
	const trimmed = value.trim();
	if (trimmed === '') {
		return Err(ApiErr.validationError('A task needs a title'));
	}
	return Ok(trimmed);
}

function create(target: RecordTarget, values: RecordValues, parent: string | null): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const token = $(tokenOf(target));
		if (parent === null) {
			return $(Err(ApiErr.validationError('A task goes in a list: give the Inbox’s or a list’s id as parent')));
		}
		const ref = $(requirePresent(parseRecordId(parent), notFound(parent)));
		if (ref.kind === 'task') {
			return $(Err(ApiErr.validationError('A task goes in a list, not inside another task')));
		}
		const name = $(await listName(token, ref.projectId));
		const projectId = ref.projectId === INBOX_ID ? $(await inboxId(token)) : ref.projectId;
		const content = values.content ?? '';
		const created = $(
			await createTask(token, {
				title: $(title(values.title ?? '')),
				...(projectId ? {projectId} : {}),
				...(content !== '' ? {content} : {}),
				priority: priorityValue(values.priority ?? ''),
			}),
		);
		return taskRecord(created, name);
	});
}

// The fields written differently from the task as it is, as TickTick takes them.
function changedFields(task: TickTickTask, current: RecordValues, values: RecordValues): Result<TaskFields, ApiError> {
	const fields: TaskFields = {};
	if (values.title !== undefined && values.title.trim() !== current.title) {
		const written = title(values.title);
		if (written.isErr()) {
			return written;
		}
		fields.title = written.value;
	}
	if (values.content !== undefined && values.content !== current.content) {
		fields[contentKey(task)] = values.content;
	}
	if (values.priority !== undefined && (values.priority || 'None') !== current.priority) {
		fields.priority = priorityValue(values.priority);
	}
	return Ok(fields);
}

function update(target: RecordTarget, recordId: string, values: RecordValues): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const token = $(tokenOf(target));
		const ref = $(requireTask(recordId, 'edited'));
		const {task, list} = $(await fetchTask(token, recordId, ref));
		const fields = $(changedFields(task, taskValues(task, list), values));
		if (Object.keys(fields).length === 0) {
			return taskRecord(task, list);
		}
		const updated = $(await updateTask(token, task, fields));
		return taskRecord(updated, list);
	});
}

// Completed, the task leaves its list's open tasks. TickTick answers completing a task it doesn't
// have as if it had, so the task is fetched first.
function complete(target: RecordTarget, recordId: string): Promise<Result<DataRecord | null, ApiError>> {
	return Do(async ($) => {
		const token = $(tokenOf(target));
		const ref = $(requireTask(recordId, 'completed'));
		const {task} = $(await fetchTask(token, recordId, ref));
		if (task.status === 2) {
			return $(Err(ApiErr.validationError('This task is already completed')));
		}
		$(await completeTask(token, task.projectId, task.id));
		return null;
	});
}

export const ticktickConnector: Connector = {
	list,
	get,
	create,
	update,
	remove: () => Promise.resolve(Err(ApiErr.validationError('TickTick tasks are not deleted here'))),
	commands: {complete},
};
