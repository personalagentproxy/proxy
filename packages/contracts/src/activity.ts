import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';

/**
 * The activity log (`/api/orgs/:org/activity/…`): the requests made of the connections the person
 * sees, the tasks they were made for, a task's page, and the home page's timeline.
 */

/** The web app's agent pages, the MCP server, or the built-in agent's own loop. */
const viaSchema = z.enum(['web', 'mcp', 'harness']);

const outcomeSchema = z.enum(['allowed', 'denied', 'failed']);

export const auditEntrySchema = z.object({
	id: z.string(),
	at: z.string(),
	/** None for what Personal Agent Proxy did itself, as the home page's widgets write. */
	agentId: z.string().nullable(),
	connectionId: z.string(),
	collectionId: z.string(),
	/** list, view, create, update or delete, or a command of the collection, such as `send`. */
	action: z.string(),
	recordTitle: z.string().nullable(),
	query: z.string().nullable(),
	outcome: outcomeSchema,
	/**
	 * What went wrong, for a failed request: the api's kind of error, with the provider's HTTP
	 * status where it answered with one, such as `provider_unreachable 429`; none for every other
	 * outcome.
	 */
	error: z.string().nullable(),
	/** The web app's agent pages, the MCP server, or the built-in agent's own loop. */
	via: viaSchema,
	/**
	 * The agent's task the request was made for, among the answer's `tasks`; none for entries from
	 * before tasks, and for what Personal Agent Proxy did itself.
	 */
	taskId: z.string().nullable(),
	/**
	 * How long the request took; none for entries from before it was kept, and for what Personal
	 * Agent Proxy did itself.
	 */
	durationMs: z.number().nullable(),
	/**
	 * The member who asked for what Personal Agent Proxy did itself, and their name or address
	 * while they are in the organization; null for an agent's request, and for entries from before
	 * it was kept.
	 */
	userId: z.string().nullable(),
	userName: z.string().nullable(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** What an agent set out to do, as it said when it started: what the entries made for it were for. */
export const activityTaskSchema = z.object({
	id: z.string(),
	agentId: z.string(),
	/**
	 * The persona of the Chat page a sub-agent ran it as, with its head; null for every other
	 * task, and for one whose persona is gone.
	 */
	persona: z
		.object({id: z.string(), name: z.string(), look: lookSchema, color: z.enum(AVATAR_COLORS)})
		.nullable(),
	/**
	 * The agent's task it is a sub-task of, where the agent handed part of that task to a
	 * sub-agent; null for a task started on its own. The parent may be missing from the answer.
	 */
	parentId: z.string().nullable(),
	title: z.string(),
	goal: z.string(),
	via: viaSchema,
	startedAt: z.string(),
	/** Null while the agent hasn't called it finished, left open (@proxy/utils/tasks) or not. */
	finishedAt: z.string().nullable(),
	/** What was done or found, as the agent said when it finished; null where it said nothing. */
	outcome: z.string().nullable(),
	/**
	 * When it, or one of its sub-tasks at any depth, was last started or had a request made for
	 * it: one never finished is taken as left open 20 minutes after (@proxy/utils/tasks).
	 */
	lastActiveAt: z.string(),
});

export type ActivityTask = z.infer<typeof activityTaskSchema>;

/**
 * `GET activity`'s filters: an agent's requests, `proxy` for what Personal Agent Proxy did itself,
 * a connection's, one task's, or those of one outcome.
 */
export const activityQuerySchema = z.object({
	agentId: z.string().min(1).optional(),
	connectionId: z.string().min(1).optional(),
	taskId: z.string().min(1).optional(),
	outcome: outcomeSchema.optional(),
});

export type ActivityFilter = z.input<typeof activityQuerySchema>;

/**
 * `GET activity`: the requests the person sees, newest first, the latest 500, and the tasks they
 * were made for; with `?taskId=`, that task too, even before any request was made for it.
 */
export const activityListSchema = z.object({
	entries: z.array(auditEntrySchema),
	tasks: z.array(activityTaskSchema),
});

/** `GET activity/tasks/:taskId`: a task's page, the task, every task handed on from it, and every request made for them. */
export const taskRunSchema = z.object({
	/** When the answer was made: where a task still under way has got to. */
	now: z.string(),
	/** The task the page is about, first among `tasks`. */
	task: z.string(),
	/** The agent whose task it is. */
	agentId: z.string(),
	/** The task it is a sub-task of, where it is one the person sees; null for a task started on its own. */
	parent: activityTaskSchema.nullable(),
	/** The task and every task handed on from it, at any depth, in the order started: how it ran. */
	tasks: z.array(activityTaskSchema),
	/** Every request made for them, in the order they were made. */
	entries: z.array(auditEntrySchema),
});

export type TaskRun = z.infer<typeof taskRunSchema>;

/**
 * `GET activity/timeline?from=…&to=…`: the home page's timeline, every task under way at some
 * point between `from` and `to`, with its sub-tasks, and the requests made for them.
 */
export const activityTimelineSchema = z.object({
	/** When the answer was made: the right edge of the timeline. */
	now: z.string(),
	from: z.string(),
	/** Where the stretch of time read ends: `?to=`, or now without it. */
	to: z.string(),
	/** Every task under way at some point between `from` and `to`, with its sub-tasks, newest first. */
	tasks: z.array(activityTaskSchema),
	/** The requests made for them between `from` and `to`, in the order they were made. */
	entries: z.array(auditEntrySchema),
});

export type ActivityTimeline = z.infer<typeof activityTimelineSchema>;
