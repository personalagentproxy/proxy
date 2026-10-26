import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {type AuditEntryRow, listAuditEntries, listLastTaskEntries, listTaskEntries} from '@proxy/db/audit';
import {listMemberNames} from '@proxy/db/organization';
import {type AgentTaskRow, listAgentTasks, listAgentTasksBetween, listSubTasks} from '@proxy/db/task';
import type {Viewer} from '@proxy/db/viewer';

import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer} from '../utils/user-org';

const MAX_ENTRIES = 500;

export type AuditEntryResponse = {
	id: string;
	at: string;
	// None for what Personal Agent Proxy did itself, as the home page's widgets write.
	agentId: string | null;
	connectionId: string;
	collectionId: string;
	// list, view, create, update or delete, or a command of the collection, such as `send`.
	action: string;
	recordTitle: string | null;
	query: string | null;
	outcome: 'allowed' | 'denied' | 'failed';
	// What went wrong, for a failed request: the api's kind of error, with the provider's HTTP status
	// where it answered with one, such as `provider_unreachable 429`; none for every other outcome.
	error: string | null;
	// The web app's agent pages, the MCP server, or the built-in agent's own loop.
	via: 'web' | 'mcp' | 'harness';
	// The agent's task the request was made for, among the answer's `tasks`; none for entries from
	// before tasks, and for what Personal Agent Proxy did itself.
	taskId: string | null;
	// How long the request took; none for entries from before it was kept, and for what Personal
	// Agent Proxy did itself.
	durationMs: number | null;
	// The member who asked for what Personal Agent Proxy did itself, and their name or address while
	// they are in the organization; null for an agent's request, and for entries from before it was
	// kept.
	userId: string | null;
	userName: string | null;
};

/** What an agent set out to do, as it said when it started: what the entries made for it were for. */
export type ActivityTaskResponse = {
	id: string;
	agentId: string;
	// The agent's task it is a sub-task of, where the agent handed part of that task to a sub-agent;
	// null for a task started on its own. The parent may be missing from the answer.
	parentId: string | null;
	title: string;
	goal: string;
	via: 'web' | 'mcp' | 'harness';
	startedAt: string;
	// Null while the agent hasn't called it finished, abandoned (@proxy/utils/tasks) or not.
	finishedAt: string | null;
	// What was done or found, as the agent said when it finished; null where it said nothing.
	outcome: string | null;
	// When it, or the last of its sub-tasks at any depth, was started: one never finished is taken
	// as abandoned a day after (@proxy/utils/tasks).
	lastStartedAt: string;
};

function toActivityTask({createdAt, finishedAt, lastStartedAt, ...task}: AgentTaskRow): ActivityTaskResponse {
	return {...task, startedAt: createdAt.toISOString(), finishedAt: finishedAt?.toISOString() ?? null, lastStartedAt: lastStartedAt.toISOString()};
}

// `?agentId=proxy` is what Personal Agent Proxy did itself.
const PROXY = 'proxy';

const querySchema = z.object({
	agentId: z.string().min(1).optional(),
	connectionId: z.string().min(1).optional(),
	taskId: z.string().min(1).optional(),
	outcome: z.enum(['allowed', 'denied', 'failed']).optional(),
});

/**
 * The requests the person sees in the organization, newest first, the latest 500: shared agents'
 * and their own agents', on shared connections and their own; and the tasks they were made for;
 * with `?taskId=`, that task too, even before any request was made for it.
 */
export function handleListActivityRoute(request: AuthenticatedRequest): Promise<Result<{entries: AuditEntryResponse[]; tasks: ActivityTaskResponse[]}, ApiError>> {
	return Do(async ($) => {
		const {agentId, connectionId, taskId, outcome} = $(parseSchema(querySchema, request.query));
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
		return {entries: $(await toEntries(viewer, rows)), tasks: tasks.map(toActivityTask)};
	});
}

// The entries as the web app reads them, each with the name of the member who asked, where one did.
function toEntries(viewer: Viewer, rows: AuditEntryRow[]): Promise<Result<AuditEntryResponse[], ApiError>> {
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

export type TaskRunResponse = {
	// When the answer was made: where a task still under way has got to.
	now: string;
	// The task the page is about, first among `tasks`.
	task: string;
	// The agent whose task it is.
	agentId: string;
	// The task it is a sub-task of, where it is one the person sees; null for a task started on its own.
	parent: ActivityTaskResponse | null;
	// The task and every task handed on from it, at any depth, in the order started: how it ran.
	tasks: ActivityTaskResponse[];
	// Every request made for them, in the order they were made.
	entries: AuditEntryResponse[];
};

/** `GET /activity/tasks/:taskId`: a task the person sees, its sub-tasks at every depth, and every request made for them. */
export function handleTaskRunRoute(request: AuthenticatedRequest): Promise<Result<TaskRunResponse, ApiError>> {
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
			parent: parent === undefined ? null : toActivityTask(parent),
			tasks: tasks.map(toActivityTask),
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

export type ActivityTimelineResponse = {
	// When the answer was made: the right edge of the timeline.
	now: string;
	from: string;
	// Where the stretch of time read ends: `?to=`, or now without it.
	to: string;
	// Every task under way at some point between `from` and `to`, with its sub-tasks, newest first.
	tasks: ActivityTaskResponse[];
	// The requests made for them between `from` and `to`, in the order they were made; and, where
	// `to` is before now, each task's last made after it.
	entries: AuditEntryResponse[];
};

/**
 * The tasks the person sees under way at some point between `?from=` and `?to=`, or now,
 * shared agents' and their own agents', with their sub-tasks and the requests made for them.
 */
export function handleActivityTimelineRoute(request: AuthenticatedRequest): Promise<Result<ActivityTimelineResponse, ApiError>> {
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
		// Read back from before now, a task given up on may have had requests made after the stretch:
		// the last of them says when it ended (@/lib/timeline-window's endsOf in the web app).
		const later = to < now ? $(await listLastTaskEntries(viewer, ids, to)) : [];
		return {
			now: now.toISOString(),
			from: from.toISOString(),
			to: to.toISOString(),
			tasks: tasks.map(toActivityTask),
			entries: $(await toEntries(viewer, [...rows, ...later])),
		};
	});
}
