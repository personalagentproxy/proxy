import {mcpToolSchema} from '@proxy/integrations';
import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';
import {z} from 'zod';

// The api's response shapes, shared by the human side's and the agent side's clients.

export const connectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
	// Shared with every member of its organization, rather than one member's own.
	shared: z.boolean(),
	// Who connected it, kept once it is shared, and their name or address while they are still in
	// its organization.
	connectedById: z.string().nullable(),
	connectedBy: z.string().nullable(),
	// The actions agents get by default.
	defaults: z.array(z.string()),
	// A custom MCP server's tools, what its actions are; null for every other integration.
	tools: z.array(mcpToolSchema).nullable(),
	// What the person called the connection, where they named it; null for every other integration.
	name: z.string().nullable(),
	// The actions the connection's sign-in didn't cover: no agent gets them until it is signed in again.
	unavailable: z.array(z.string()),
	// It has no sign-in at all, as one moved over from a custom MCP server may not: every action is
	// unavailable until the person signs in.
	signInNeeded: z.boolean(),
});

export const agentSchema = z.object({
	id: z.string(),
	providerId: z.string(),
	name: z.string(),
	username: z.string(),
	// Shared with every member of its organization, rather than one member's own.
	shared: z.boolean(),
	// Who made it, kept once it is shared, and their name or address while they are still in its
	// organization.
	createdById: z.string().nullable(),
	createdBy: z.string().nullable(),
	createdAt: z.string(),
	lastActiveAt: z.string().nullable(),
	revokedAt: z.string().nullable(),
	// The agent's own settings, one per action; every other action follows the default.
	grants: z.array(z.object({connectionId: z.string(), actionId: z.string(), allowed: z.boolean()})),
});

export const dataRecordSchema = z.object({
	id: z.string(),
	values: z.record(z.string(), z.string()),
	updatedAt: z.string(),
	// Where the person sees it in the provider's own app, as Gmail shows it, where it has one.
	url: z.string().optional(),
	// In a nested collection, whether it holds records of its own to list.
	hasChildren: z.boolean().optional(),
});

export const auditEntrySchema = z.object({
	id: z.string(),
	at: z.string(),
	// None for what Personal Agent Proxy did itself, as the home page's widgets write.
	agentId: z.string().nullable(),
	connectionId: z.string(),
	collectionId: z.string(),
	action: z.string(),
	recordTitle: z.string().nullable(),
	query: z.string().nullable(),
	outcome: z.enum(['allowed', 'denied', 'failed']),
	// What went wrong, for a failed request: the api's kind of error, with the provider's HTTP
	// status where it answered with one, such as `provider_unreachable 429`.
	error: z.string().nullable(),
	// The web app's agent pages, the MCP server, or the built-in agent's own loop.
	via: z.enum(['web', 'mcp', 'harness']),
	// The agent's task it was made for, among the answer's tasks; none for entries from before
	// tasks, and for what Personal Agent Proxy did itself.
	taskId: z.string().nullable(),
	// How long the request took; none for entries from before it was kept, and for what Personal
	// Agent Proxy did itself.
	durationMs: z.number().nullable(),
	// The member who asked for what Personal Agent Proxy did itself, and their name while they are
	// in the organization; null for an agent's request.
	userId: z.string().nullable(),
	userName: z.string().nullable(),
});

// What an agent set out to do, as it said when it started: what the entries made for it were for.
export const activityTaskSchema = z.object({
	id: z.string(),
	agentId: z.string(),
	// The persona of the Chat page a sub-agent ran it as, with its head; null for every other task.
	persona: z
		.object({id: z.string(), name: z.string(), look: lookSchema, color: z.enum(AVATAR_COLORS)})
		.nullable(),
	// The agent's task it is a sub-task of, handed to one of its sub-agents; null for one started
	// on its own.
	parentId: z.string().nullable(),
	title: z.string(),
	goal: z.string(),
	via: z.enum(['web', 'mcp', 'harness']),
	startedAt: z.string(),
	// Null while the agent hasn't called it finished.
	finishedAt: z.string().nullable(),
	// What was done or found, as the agent said when it finished; null where it said nothing.
	outcome: z.string().nullable(),
	// When it, or one of its sub-tasks at any depth, was last started or had a request made for it:
	// one never finished is taken as left open 20 minutes after (@proxy/utils/tasks).
	lastActiveAt: z.string(),
});

// The home page's timeline: every task under way at some point between `from` and `to`, with its
// sub-tasks, and the requests made for them.
export const activityTimelineSchema = z.object({
	// When the answer was made: the right edge of the timeline.
	now: z.string(),
	from: z.string(),
	// `now`, where the stretch read runs up to it.
	to: z.string(),
	// Newest first.
	tasks: z.array(activityTaskSchema),
	// Those since `from`, in the order they were made.
	entries: z.array(auditEntrySchema),
});

export type ActivityTimeline = z.infer<typeof activityTimelineSchema>;

// A task's page: the task, every task handed on from it, and every request made for them.
export const taskRunSchema = z.object({
	// When the answer was made: where a task still under way has got to.
	now: z.string(),
	// The task the page is about, first among `tasks`.
	task: z.string(),
	agentId: z.string(),
	// The task it is a sub-task of, where it is one the person sees.
	parent: activityTaskSchema.nullable(),
	// The task and its sub-tasks at every depth, in the order started.
	tasks: z.array(activityTaskSchema),
	// In the order they were made.
	entries: z.array(auditEntrySchema),
});

export type TaskRun = z.infer<typeof taskRunSchema>;
