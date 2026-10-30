import {mcpToolSchema} from '@proxy/integrations';
import {z} from 'zod';

import {dataRecordSchema, type RecordPage} from './records';

/**
 * The agent side over HTTP (`/api/agent/…`), for the web app's agent pages, signed in with the
 * agent's cookie: the same tasks, connections, tools and runs as the MCP server.
 */

/** A connection as the agent sees it: what it can do with it. */
export const agentConnectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
	/** Shared with everyone in the organization, rather than the agent's owner's own. */
	shared: z.boolean(),
	/** The actions the agent can take with the connection. */
	actions: z.array(z.string()),
	/**
	 * A custom MCP server's tools the agent may run, as the server describes them; null for every
	 * other integration.
	 */
	tools: z.array(mcpToolSchema).nullable(),
	/** What the person called the connection, where they named it. */
	name: z.string().nullable(),
});

export type AgentConnection = z.infer<typeof agentConnectionSchema>;

/** `GET me`: who the agent is and what it can do with each connection; connections it can't use are left out. */
export const agentMeSchema = z.object({
	agent: z.object({id: z.string(), providerId: z.string(), name: z.string()}),
	connections: z.array(agentConnectionSchema),
});

export type AgentMe = z.infer<typeof agentMeSchema>;

/** A task as an agent sees it. */
export const agentTaskSchema = z.object({
	/** The task's id, which every other call, and every run, takes. */
	task: z.string(),
	/** The task it is a sub-task of, or null. */
	parent: z.string().nullable(),
	title: z.string(),
	goal: z.string(),
	startedAt: z.string(),
	finishedAt: z.string().nullable(),
	/** What was done, once finished with one. */
	outcome: z.string().nullable(),
});

export type AgentTask = z.infer<typeof agentTaskSchema>;

/** `GET tasks`: the agent's tasks still under way, newest first: it can have any number at once. */
export const agentTaskListSchema = z.object({tasks: z.array(agentTaskSchema)});

/**
 * `POST tasks`: starts a task, `{title, goal}`, both trimmed and neither empty, and `parent` where
 * it is a sub-task, the id of one of the agent's tasks not finished.
 */
export const startTaskBodySchema = z.object({
	title: z.string(),
	goal: z.string(),
	parent: z.string().optional(),
});

/** Finishes the task `task`, with `outcome`, what was done or found, where the agent gives one. */
export const finishTaskBodySchema = z.object({task: z.string(), outcome: z.string().optional()});

/** `POST connections/:connectionId/tools/:toolName`: a run, for the task `task`, by its id. */
export const runToolBodySchema = z.object({
	task: z.string().min(1),
	params: z.unknown().optional(),
});

/** What a tool that opened, wrote or ran on a record answered: the record after, or null once it has left the collection. */
export const recordToolResultSchema = z.object({record: dataRecordSchema.nullable()});

/** What one of a custom MCP server's tools answered. */
export const serverToolResultSchema = z.object({text: z.string()});

/** A run's answer: a page of records from a list (`recordPageSchema`), a record, or what a custom server's tool answered. */
export type ToolResult =
	RecordPage | z.infer<typeof recordToolResultSchema> | z.infer<typeof serverToolResultSchema>;

/**
 * `POST feedback`: feedback for the makers of Personal Agent Proxy, `{message}`, and the
 * connection, the tool and the task it is about where it names them, kept as the agent gave them.
 */
export const feedbackBodySchema = z.object({
	message: z.string(),
	connection: z.string().max(200).optional(),
	tool: z.string().max(200).optional(),
	task: z.string().max(200).optional(),
});

export const feedbackSentSchema = z.object({sent: z.literal(true)});
