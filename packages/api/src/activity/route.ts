import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import {listAuditEntries, summarizeTaskRequests} from '@proxy/db/audit';
import {listMemberNames} from '@proxy/db/organization';
import {type AgentTaskRow, listAgentTasks, listAgentTasksSince} from '@proxy/db/task';

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
	outcome: 'allowed' | 'denied';
	// The web app's agent pages, or the MCP server.
	via: 'web' | 'mcp';
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
	via: 'web' | 'mcp';
	startedAt: string;
	// Null while the agent hasn't called it finished, abandoned (@proxy/utils/tasks) or not.
	finishedAt: string | null;
	// What was done or found, as the agent said when it finished; null where it said nothing.
	outcome: string | null;
};

function toActivityTask({createdAt, finishedAt, ...task}: AgentTaskRow): ActivityTaskResponse {
	return {...task, startedAt: createdAt.toISOString(), finishedAt: finishedAt?.toISOString() ?? null};
}

// `?agentId=proxy` is what Personal Agent Proxy did itself.
const PROXY = 'proxy';

const querySchema = z.object({
	agentId: z.string().min(1).optional(),
	connectionId: z.string().min(1).optional(),
	taskId: z.string().min(1).optional(),
	outcome: z.enum(['allowed', 'denied']).optional(),
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
		const userIds = new Set(rows.flatMap((row) => (row.userId === null ? [] : [row.userId])));
		const tasks = $(await listAgentTasks(viewer, [...taskIds]));
		const names = $(await listMemberNames([...userIds].map((userId) => ({orgId: viewer.orgId, userId}))));
		const nameOf = (userId: string | null) => names.find((member) => member.userId === userId)?.name ?? null;
		return {
			entries: rows.map(({createdAt, ...entry}) => ({...entry, at: createdAt.toISOString(), userName: nameOf(entry.userId)})),
			tasks: tasks.map(toActivityTask),
		};
	});
}

// The home page's lanes: at most this many tasks, and a window at most this far back.
const MAX_TASKS = 200;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

const lanesQuerySchema = z.object({from: z.iso.datetime({offset: true})});

/** A task as the home page's lanes draw it: when it ran, and what was done for it. */
export type LaneTaskResponse = ActivityTaskResponse & {
	// How many requests were made for it, and how many of them were refused.
	requests: number;
	denied: number;
	// The connections its requests used, the most used first, the earlier used first among equals.
	connectionIds: string[];
};

export type ActivityLanesResponse = {
	// When the answer was made: the right edge of the lanes.
	now: string;
	from: string;
	// Every task under way at some point since `from`, newest first.
	tasks: LaneTaskResponse[];
};

/** The tasks the person sees under way at some point since `?from=`, shared agents' and their own agents', with what was done for each. */
export function handleActivityLanesRoute(request: AuthenticatedRequest): Promise<Result<ActivityLanesResponse, ApiError>> {
	return Do(async ($) => {
		const query = $(parseSchema(lanesQuerySchema, request.query));
		const viewer = $(await requireViewer(request));
		const now = new Date();
		const from = new Date(Math.max(new Date(query.from).getTime(), now.getTime() - MAX_WINDOW_MS));
		const rows = $(await listAgentTasksSince(viewer, from, MAX_TASKS));
		const requests = $(
			await summarizeTaskRequests(
				viewer.orgId,
				rows.map((row) => row.id),
			),
		);
		const tasks = rows.map((task) => {
			const own = requests.filter((row) => row.taskId === task.id);
			const used = new Map<string, {count: number; first: Date}>();
			for (const row of own) {
				const known = used.get(row.connectionId) ?? {count: 0, first: row.first};
				used.set(row.connectionId, {count: known.count + row.count, first: row.first < known.first ? row.first : known.first});
			}
			return {
				...toActivityTask(task),
				requests: own.reduce((total, row) => total + row.count, 0),
				denied: own.filter((row) => row.outcome === 'denied').reduce((total, row) => total + row.count, 0),
				connectionIds: [...used.entries()].sort((a, b) => b[1].count - a[1].count || a[1].first.getTime() - b[1].first.getTime()).map(([connectionId]) => connectionId),
			};
		});
		return {now: now.toISOString(), from: from.toISOString(), tasks};
	});
}
