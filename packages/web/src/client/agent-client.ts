import {mcpToolSchema} from '@proxy/integrations';
import {z} from 'zod';
import {dataRecordSchema} from '@/client/schemas';
import {apiRequest, apiSend} from '@/client/request';

// The agent side: its own sign-in and cookie. Every records call is made for a task, the one in
// the page's address (lib/agent-task.ts), checked against the agent's access and logged by the api
// with the task, a refused one (403) too.

const agentMeSchema = z.object({
	agent: z.object({id: z.string(), providerId: z.string(), name: z.string()}),
	connections: z.array(
		z.object({
			id: z.string(),
			integrationId: z.string(),
			account: z.string(),
			// Shared with everyone in the organization, rather than the agent's owner's own.
			shared: z.boolean(),
			// The actions the agent can take with the connection.
			actions: z.array(z.string()),
			// A custom MCP server's tools the agent may run; null for every other integration.
			tools: z.array(mcpToolSchema).nullable(),
			// What the person called the connection, where they named it.
			name: z.string().nullable(),
		}),
	),
});

export type AgentMe = z.infer<typeof agentMeSchema>;

/** 401 wrong username or password, 403 a revoked login. */
export function signInAgent(username: string, password: string) {
	return apiRequest('POST', '/agent-auth/login', z.object({agentId: z.string()}), {
		username,
		password,
	});
}

export function signOutAgent() {
	return apiSend('POST', '/agent-auth/logout');
}

const agentTaskSchema = z.object({
	// The task's id, which every run is made with.
	task: z.string(),
	title: z.string(),
	goal: z.string(),
	startedAt: z.string(),
	finishedAt: z.string().nullable(),
});

export type AgentTask = z.infer<typeof agentTaskSchema>;

/** The agent's tasks still under way, newest first: it can have any number at once. */
export function listAgentTasks() {
	return apiRequest('GET', '/api/agent/tasks', z.object({tasks: z.array(agentTaskSchema)}));
}

/** The task while it is under way: 404 for one unknown, 409 for one finished or abandoned. */
export function getAgentTask(taskId: string) {
	return apiRequest('GET', `/api/agent/tasks/${encodeURIComponent(taskId)}`, agentTaskSchema);
}

/** Starts a task: what the agent is about to do for the person, as the MCP server's start_task takes it. */
export function startAgentTask(task: {title: string; goal: string}) {
	return apiRequest('POST', '/api/agent/tasks', agentTaskSchema, task);
}

/** Marks the task finished, as finish_task does. */
export function finishAgentTask(taskId: string) {
	return apiRequest(
		'POST',
		`/api/agent/tasks/${encodeURIComponent(taskId)}/finish`,
		agentTaskSchema,
	);
}

/** Who is signed in and everything it can reach. A 401 means "send it to /agent/login". */
export function getAgentMe() {
	return apiRequest('GET', '/api/agent/me', agentMeSchema);
}

// Everything an agent does with a connection is one of its tools, generated from the catalog
// (`toolName` in @proxy/integrations): the page asks for a list or a record and gets one back.
function toolPath(connectionId: string, tool: string): string {
	return `/api/agent/connections/${connectionId}/tools/${encodeURIComponent(tool)}`;
}

/**
 * Runs a list tool: a page of records, newest first, and the token of the next, older page. A list
 * opened inside a record says where it is: that record last, those above it before it.
 */
export function runAgentListTool(
	taskId: string,
	connectionId: string,
	tool: string,
	params: Record<string, string>,
) {
	return apiRequest(
		'POST',
		toolPath(connectionId, tool),
		z.object({
			records: z.array(dataRecordSchema),
			nextPage: z.string().nullable(),
			trail: z.array(z.object({id: z.string(), title: z.string()})).optional(),
		}),
		{task: taskId, params},
	);
}

/** Runs one of a custom MCP server's tools with its params as the server takes them: what the tool answered. */
export function runAgentServerTool(
	taskId: string,
	connectionId: string,
	tool: string,
	params: Record<string, unknown>,
) {
	return apiRequest('POST', toolPath(connectionId, tool), z.object({text: z.string()}), {
		task: taskId,
		params,
	});
}

/**
 * Runs any other tool, such as opening a record, saving a draft or Archive: the record after, or
 * null once it has left the collection.
 */
export function runAgentRecordTool(
	taskId: string,
	connectionId: string,
	tool: string,
	params: Record<string, string>,
) {
	return apiRequest(
		'POST',
		toolPath(connectionId, tool),
		z.object({record: dataRecordSchema.nullable()}),
		{task: taskId, params},
	);
}

/**
 * Feedback for the makers of Personal Agent Proxy, such as a page that didn't work as the agent
 * expected, and the connection, the tool and the task it is about where there are any.
 */
export function sendAgentFeedback(feedback: {
	message: string;
	connection?: string;
	tool?: string;
	task?: string;
}) {
	return apiRequest('POST', '/api/agent/feedback', z.object({sent: z.literal(true)}), feedback);
}
