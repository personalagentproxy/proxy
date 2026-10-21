import {mcpToolSchema} from '@proxy/integrations';
import {z} from 'zod';

// The api's response shapes, shared by the human side's and the agent side's clients.

export const connectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
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
	outcome: z.enum(['allowed', 'denied']),
	// The web app's agent pages, or the MCP server.
	via: z.enum(['web', 'mcp']),
	// The agent's task it was made for, among the answer's tasks; none for entries from before
	// tasks, and for what Personal Agent Proxy did itself.
	taskId: z.string().nullable(),
});

// What an agent set out to do, as it said when it started: what the entries made for it were for.
export const activityTaskSchema = z.object({
	id: z.string(),
	agentId: z.string(),
	title: z.string(),
	goal: z.string(),
	via: z.enum(['web', 'mcp']),
	startedAt: z.string(),
	// Null while the agent hasn't called it finished.
	finishedAt: z.string().nullable(),
});

// A task as the home page's lanes draw it: when it ran, and what was done for it.
export const laneTaskSchema = activityTaskSchema.extend({
	// How many requests were made for it, and how many of them were refused.
	requests: z.number(),
	denied: z.number(),
	// The connections its requests used, the most used first.
	connectionIds: z.array(z.string()),
});

export type LaneTask = z.infer<typeof laneTaskSchema>;

export const activityLanesSchema = z.object({
	// When the answer was made: the right edge of the lanes.
	now: z.string(),
	from: z.string(),
	// Every task under way at some point since `from`, newest first.
	tasks: z.array(laneTaskSchema),
});

export type ActivityLanes = z.infer<typeof activityLanesSchema>;
