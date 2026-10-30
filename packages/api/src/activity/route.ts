import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {type AuditEntryRow, listAuditEntries, listTaskEntries} from '@proxy/db/audit';
import {listMemberNames} from '@proxy/db/organization';
import {toAvatarColor} from '@proxy/utils/harness';
import {listPersonasById} from '@proxy/db/harness';
import {type AgentTaskRow, listAgentTasks, listAgentTasksBetween, listSubTasks} from '@proxy/db/task';
import type {Viewer} from '@proxy/db/viewer';
import {type ActivityTask, type ActivityTimeline, type AuditEntry, type activityListSchema, activityQuerySchema, type TaskRun} from '@proxy/contracts/activity';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';

const MAX_ENTRIES = 500;

// The tasks as the web app reads them, each with the persona it was run as, where it was.
function toActivityTasks(viewer: Viewer, rows: AgentTaskRow[]): Promise<Result<ActivityTask[], ApiError>> {
	return Do(async ($) => {
		const personaIds = new Set(rows.flatMap((row) => (row.personaId === null ? [] : [row.personaId])));
		const personas = $(await listPersonasById(viewer.orgId, [...personaIds]));
		return rows.map(({createdAt, finishedAt, lastActiveAt, personaId, ...task}) => {
			const persona = personas.find((candidate) => candidate.id === personaId);
			return {
				...task,
				persona: persona ? {id: persona.id, name: persona.name, look: persona.look, color: toAvatarColor(persona.color)} : null,
				startedAt: createdAt.toISOString(),
				finishedAt: finishedAt?.toISOString() ?? null,
				lastActiveAt: lastActiveAt.toISOString(),
			};
		});
	});
}

// `?agentId=proxy` is what Personal Agent Proxy did itself.
const PROXY = 'proxy';

/**
 * The requests the person sees in the organization, newest first, the latest 500: shared agents'
 * and their own agents', on shared connections and their own; and the tasks they were made for;
 * with `?taskId=`, that task too, even before any request was made for it.
 */
export function handleListActivityRoute(request: AuthenticatedRequest): Promise<Result<z.infer<typeof activityListSchema>, ApiError>> {
	return Do(async ($) => {
		const {agentId, connectionId, taskId, outcome} = $(parseSchema(activityQuerySchema, request.query));
		const viewer = $(await requireViewer(request));
		const filter = {
			...(agentId === undefined ? {} : {agentId: agentId === PROXY ? null : agentId}),
			...(connectionId === undefined ? {} : {connectionId}),
			...(taskId === undefined ? {} : {taskId}),
			...(outcome === undefined ? {} : {outcome}),
		};
		const rows = $(await listAuditEntries(viewer, filter, MAX_ENTRIES));
		const taskIds = new Set([...rows.flatMap((row) => (row.taskId === null ? [] : [row.taskId])), ...(taskId === undefined ? [] : [taskId])]);
		const tasks = $(await listAgentTasks(viewer, [...taskIds]));
		return {entries: $(await toEntries(viewer, rows)), tasks: $(await toActivityTasks(viewer, tasks))};
	});
}

// The entries as the web app reads them, each with the name of the member who asked, where one did.
function toEntries(viewer: Viewer, rows: AuditEntryRow[]): Promise<Result<AuditEntry[], ApiError>> {
	return Do(async ($) => {
		const userIds = new Set(rows.flatMap((row) => (row.userId === null ? [] : [row.userId])));
		const names = $(await listMemberNames([...userIds].map((userId) => ({orgId: viewer.orgId, userId}))));
		const nameOf = (userId: string | null) => names.find((member) => member.userId === userId)?.name ?? null;
		return rows.map(({createdAt, ...entry}) => ({...entry, at: createdAt.toISOString(), userName: nameOf(entry.userId)}));
	});
}

// A task's page: at most this many sub-tasks under the task, and at most this many requests made
// for it and them.
const MAX_SUB_TASKS = 500;
const MAX_RUN_ENTRIES = 2000;

/** `GET /activity/tasks/:taskId`: a task the person sees, its sub-tasks at every depth, and every request made for them. */
export function handleTaskRunRoute(request: AuthenticatedRequest): Promise<Result<TaskRun, ApiError>> {
	return Do(async ($) => {
		const taskId = request.params.taskId ?? '';
		const viewer = $(await requireViewer(request));
		const now = new Date();
		const [task] = $(await listAgentTasks(viewer, [taskId]));
		if (task === undefined) {
			return $(Err(ApiErr.notFound('task', taskId)));
		}
		const [parent] = task.parentId === null ? [] : $(await listAgentTasks(viewer, [task.parentId]));
		const tasks = [task, ...$(await listSubTasks(viewer, [task.id], MAX_SUB_TASKS))];
		const rows = $(
			await listTaskEntries(
				viewer,
				tasks.map((row) => row.id),
				MAX_RUN_ENTRIES,
			),
		);
		return {
			now: now.toISOString(),
			task: task.id,
			agentId: task.agentId,
			parent: parent === undefined ? null : ($(await toActivityTasks(viewer, [parent]))[0] ?? null),
			tasks: $(await toActivityTasks(viewer, tasks)),
			entries: $(await toEntries(viewer, rows)),
		};
	});
}

// The home page's timeline: at most this many tasks of their own and this many sub-tasks of them,
// a window at most this far back, and at most this many requests made for the tasks.
const MAX_TASKS = 200;
const MAX_TIMELINE_SUB_TASKS = 1000;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_TIMELINE_ENTRIES = 2000;

const timelineQuerySchema = z.object({
	from: z.iso.datetime({offset: true}),
	to: z.iso.datetime({offset: true}).optional(),
});

/**
 * The tasks the person sees under way at some point between `?from=` and `?to=`, or now,
 * shared agents' and their own agents', with their sub-tasks and the requests made for them.
 */
export function handleActivityTimelineRoute(request: AuthenticatedRequest): Promise<Result<ActivityTimeline, ApiError>> {
	return Do(async ($) => {
		const query = $(parseSchema(timelineQuerySchema, request.query));
		const viewer = $(await requireViewer(request));
		const now = new Date();
		const from = new Date(Math.max(new Date(query.from).getTime(), now.getTime() - MAX_WINDOW_MS));
		const to = new Date(Math.min(Math.max(new Date(query.to ?? now).getTime(), from.getTime()), now.getTime()));
		const tops = $(await listAgentTasksBetween(viewer, from, to, MAX_TASKS));
		// Past the most, the sub-tasks of the newest tasks are the ones kept, as the timeline is.
		const subTasks = $(
			await listSubTasks(
				viewer,
				tops.map((task) => task.id),
				MAX_TIMELINE_SUB_TASKS,
				{newest: true},
			),
		);
		const tasks = [...tops, ...subTasks].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
		const ids = tasks.map((task) => task.id);
		// Only the stretch read shares out the most requests, so none goes to what came after it.
		const rows = $(await listTaskEntries(viewer, ids, MAX_TIMELINE_ENTRIES, {from, to}));
		return {
			now: now.toISOString(),
			from: from.toISOString(),
			to: to.toISOString(),
			tasks: $(await toActivityTasks(viewer, tasks)),
			entries: $(await toEntries(viewer, rows)),
		};
	});
}
