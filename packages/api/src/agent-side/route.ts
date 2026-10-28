import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import type {Tool} from '@proxy/integrations';

import type {AgentRequest} from '../server/middleware/require-agent';
import {sendAgentFeedback} from './feedback';
import {type AgentTaskResponse, finishAgentTask, getAgentOpenTask, listAgentOpenTasks, startAgentTask} from './tasks';
import {listAgentConnections, listAgentTools, runAgentTool, type AgentConnection, type ToolResult} from './tools';

// The agent side over HTTP, for the web app's agent pages: the same tasks, connections, tools and
// runs as the MCP server, signed in with the agent's cookie.

/** Who the agent is and what it can do with each connection; connections it can't use are left out. */
export function handleAgentMeRoute(request: AgentRequest): Promise<Result<{agent: {id: string; providerId: string; name: string}; connections: AgentConnection[]}, ApiError>> {
	return listAgentConnections(request.agent);
}

/** `GET /api/agent/connections/:connectionId/tools`: the tools the agent has with the connection. */
export function handleAgentListToolsRoute(request: AgentRequest): Promise<Result<{tools: Tool[]}, ApiError>> {
	return Do(async ($) => ({tools: $(await listAgentTools(request.agent, request.params.connectionId ?? ''))}));
}

/** `GET /api/agent/tasks`: the agent's tasks still under way, newest first. */
export function handleAgentListTasksRoute(request: AgentRequest): Promise<Result<{tasks: AgentTaskResponse[]}, ApiError>> {
	return listAgentOpenTasks(request.agent);
}

/**
 * `GET /api/agent/tasks/:taskId`: the task while it is not finished, as the agent pages open it
 * from their address; unknown is 404, finished, or under a task finished, 409, as a run for it
 * would be. Only read: one left open is taken up again by the next run made for it.
 */
export function handleAgentGetTaskRoute(request: AgentRequest): Promise<Result<AgentTaskResponse, ApiError>> {
	return getAgentOpenTask(request.agent, request.params.taskId ?? '');
}

/** `POST /api/agent/tasks` with `{title, goal, parent?}`: starts a task, a sub-task of `parent` where given, answering with its id as `task`. */
export function handleAgentStartTaskRoute(request: AgentRequest): Promise<Result<AgentTaskResponse, ApiError>> {
	return startAgentTask({agent: request.agent, via: 'web'}, request.body ?? {});
}

/** `POST /api/agent/tasks/:taskId/finish` with `{outcome?}`: marks the task finished, with what was done where given. */
export function handleAgentFinishTaskRoute(request: AgentRequest): Promise<Result<AgentTaskResponse, ApiError>> {
	return finishAgentTask({agent: request.agent, via: 'web'}, {...request.body, task: request.params.taskId ?? ''});
}

const runToolBodySchema = z.object({task: z.string().min(1), params: z.unknown().optional()});

/** `POST /api/agent/connections/:connectionId/tools/:toolName` with `{task, params}`, `task` the id of the task the run is for. */
export function handleAgentRunToolRoute(request: AgentRequest): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const {task, params} = $(parseSchema(runToolBodySchema, request.body ?? {}));
		return $(await runAgentTool({agent: request.agent, via: 'web', taskId: task}, request.params.connectionId ?? '', request.params.toolName ?? '', params));
	});
}

/** `POST /api/agent/feedback` with `{message, connection?, tool?, task?}`: feedback for the makers of Personal Agent Proxy. */
export function handleAgentFeedbackRoute(request: AgentRequest): Promise<Result<{sent: true}, ApiError>> {
	return sendAgentFeedback({agent: request.agent, via: 'web'}, request.body ?? {});
}
