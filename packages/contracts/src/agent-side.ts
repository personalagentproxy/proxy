import {z} from 'zod';

import {dataRecordSchema, type RecordPage} from './records';

/**
 * The agent side: the connections and tasks an agent works with, over MCP, in the built-in agent's
 * loop, from a sandbox's CLI, and on the agent page (`/api/agent/…`), signed in with the agent's
 * cookie, where it writes a script and sends it.
 */

/** A connection as the agent sees it: what it can do with it. */
export const agentConnectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
	/** Other members of the organization use it too: it is shared with all of them, or with some by name. */
	shared: z.boolean(),
	/** The actions the agent can take with the connection. */
	actions: z.array(z.string()),
	/** What the person called the connection, where they named it. */
	name: z.string().nullable(),
});

export type AgentConnection = z.infer<typeof agentConnectionSchema>;

const agentSchema = z.object({id: z.string(), providerId: z.string(), name: z.string()});

/** Who the agent is and what it can do with each connection; connections it can't use are left out. */
export const agentAccessSchema = z.object({
	agent: agentSchema,
	connections: z.array(agentConnectionSchema),
});

/** `GET me`: who the agent is, and what it is told, as an MCP client is when it connects. */
export const agentPageSchema = z.object({agent: agentSchema, instructions: z.string()});

export type AgentPage = z.infer<typeof agentPageSchema>;

/** `POST script`: the script, and the task its calls are for, one an earlier script started. */
export const runScriptBodySchema = z.object({
	code: z.string().trim().min(1, 'Write a script first.'),
	task: z.string().optional(),
});

/** What a script came to, in words; whether it failed; and the task to send with the next, null once it finished it. */
export const scriptRunSchema = z.object({
	text: z.string(),
	isError: z.boolean(),
	task: z.string().nullable(),
});

export type ScriptRun = z.infer<typeof scriptRunSchema>;

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

/**
 * Starts a task, `{title, goal}`, both trimmed and neither empty, and `parent` where
 * it is a sub-task, the id of one of the agent's tasks not finished.
 */
export const startTaskBodySchema = z.object({
	title: z.string(),
	goal: z.string(),
	parent: z.string().optional(),
});

/** Finishes the task `task`, with `outcome`, what was done or found, where the agent gives one. */
export const finishTaskBodySchema = z.object({task: z.string(), outcome: z.string().optional()});

/** What a tool that opened, wrote or ran on a record answered: the record after, or null once it has left the collection. */
export const recordToolResultSchema = z.object({record: dataRecordSchema.nullable()});

/** What one of a custom MCP server's tools answered. */
export const serverToolResultSchema = z.object({text: z.string()});

/** A run's answer: a page of records from a list (`recordPageSchema`), a record, or what a custom server's tool answered. */
export type ToolResult =
	RecordPage | z.infer<typeof recordToolResultSchema> | z.infer<typeof serverToolResultSchema>;

/**
 * Feedback for the makers of Personal Agent Proxy, `{message}`, and the
 * connection, the tool and the task it is about where it names them, kept as the agent gave them.
 */
export const feedbackBodySchema = z.object({
	message: z.string(),
	connection: z.string().max(200).optional(),
	tool: z.string().max(200).optional(),
	task: z.string().max(200).optional(),
});

export const feedbackSentSchema = z.object({sent: z.literal(true)});
