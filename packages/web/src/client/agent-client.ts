import {type agentLoginBodySchema, agentLoginSchema} from '@proxy/contracts/agent-auth';
import {
	agentMeSchema,
	agentTaskListSchema,
	agentTaskSchema,
	type feedbackBodySchema,
	feedbackSentSchema,
	recordToolResultSchema,
	type runToolBodySchema,
	serverToolResultSchema,
	type startTaskBodySchema,
} from '@proxy/contracts/agent-side';
import {recordPageSchema} from '@proxy/contracts/records';
import type {z} from 'zod';
import {apiRequest, apiSend} from '@/client/request';

// The agent side: its own sign-in and cookie. Every records call is made for a task, the one in
// the page's address (lib/agent-task.ts), checked against the agent's access and logged by the api
// with the task, a refused one (403) too.

/** 401 wrong username or password, 403 a revoked login. */
export function signInAgent(username: string, password: string) {
	return apiRequest('POST', '/agent-auth/login', agentLoginSchema, {
		username,
		password,
	} satisfies z.input<typeof agentLoginBodySchema>);
}

export function signOutAgent() {
	return apiSend('POST', '/agent-auth/logout');
}

/** The agent's tasks still under way, newest first: it can have any number at once. */
export function listAgentTasks() {
	return apiRequest('GET', '/api/agent/tasks', agentTaskListSchema);
}

/** The task while it is not finished: 404 for one unknown, 409 for one finished. */
export function getAgentTask(taskId: string) {
	return apiRequest('GET', `/api/agent/tasks/${encodeURIComponent(taskId)}`, agentTaskSchema);
}

/** Starts a task: what the agent is about to do for the person, as the MCP server's start_task takes it. */
export function startAgentTask(task: z.input<typeof startTaskBodySchema>) {
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

type RunToolBody = z.input<typeof runToolBodySchema>;

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
	return apiRequest('POST', toolPath(connectionId, tool), recordPageSchema, {
		task: taskId,
		params,
	} satisfies RunToolBody);
}

/** Runs one of a custom MCP server's tools with its params as the server takes them: what the tool answered. */
export function runAgentServerTool(
	taskId: string,
	connectionId: string,
	tool: string,
	params: Record<string, unknown>,
) {
	return apiRequest('POST', toolPath(connectionId, tool), serverToolResultSchema, {
		task: taskId,
		params,
	} satisfies RunToolBody);
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
	return apiRequest('POST', toolPath(connectionId, tool), recordToolResultSchema, {
		task: taskId,
		params,
	} satisfies RunToolBody);
}

/**
 * Feedback for the makers of Personal Agent Proxy, such as a page that didn't work as the agent
 * expected, and the connection, the tool and the task it is about where there are any.
 */
export function sendAgentFeedback(feedback: z.input<typeof feedbackBodySchema>) {
	return apiRequest('POST', '/api/agent/feedback', feedbackSentSchema, feedback);
}
