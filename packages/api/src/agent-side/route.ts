import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import type {Tool} from '@proxy/integrations';

import type {AgentRequest} from '../server/middleware/require-agent';
import {listAgentConnections, listAgentTools, runAgentTool, type AgentConnection, type ToolResult} from './tools';

// The agent side over HTTP, for the web app's agent pages: the same connections, tools and runs
// as the MCP server, signed in with the agent's cookie.

/** Who the agent is and what it can do with each connection; connections it can't use are left out. */
export function handleAgentMeRoute(request: AgentRequest): Promise<Result<{agent: {id: string; providerId: string; name: string}; connections: AgentConnection[]}, ApiError>> {
	return listAgentConnections(request.agent);
}

/** `GET /api/agent/connections/:connectionId/tools`: the tools the agent has with the connection. */
export function handleAgentListToolsRoute(request: AgentRequest): Promise<Result<{tools: Tool[]}, ApiError>> {
	return Do(async ($) => ({tools: $(await listAgentTools(request.agent, request.params.connectionId ?? ''))}));
}

const runToolBodySchema = z.object({params: z.unknown().optional()});

/** `POST /api/agent/connections/:connectionId/tools/:toolName` with `{params}`. */
export function handleAgentRunToolRoute(request: AgentRequest): Promise<Result<ToolResult, ApiError>> {
	return Do(async ($) => {
		const {params} = $(parseSchema(runToolBodySchema, request.body ?? {}));
		return $(await runAgentTool(request.agent, request.params.connectionId ?? '', request.params.toolName ?? '', params));
	});
}
