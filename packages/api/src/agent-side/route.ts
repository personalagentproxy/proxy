import type {Result} from 'ts-results-es';

import {type ApiError, Do, parseSchema} from '@proxy/utils';
import {type AgentPage, runScriptBodySchema, type ScriptRun} from '@proxy/contracts/agent-side';

import {pageInstructions, runAgentScript} from '../mcp/tools';
import type {AgentRequest} from '../server/middleware/require-agent';
import {requireAgent} from './tools';

// The agent page over HTTP, signed in with the agent's cookie: the `script` tool the MCP server
// has, written in a text field and sent, the same calls through the same gate and into the same
// log.

/** `GET /api/agent/me`: who the agent is, and what it is told, as an MCP client is when it connects. */
export function handleAgentMeRoute(request: AgentRequest): Promise<Result<AgentPage, ApiError>> {
	return Do(async ($) => {
		const agent = $(await requireAgent(request.agent));
		return {
			agent: {id: agent.id, providerId: agent.providerId, name: agent.name},
			instructions: $(await pageInstructions(request.agent)),
		};
	});
}

/**
 * `POST /api/agent/script` with `{code, task?}`: runs the script as the agent, for `task`, the
 * one the page kept from an earlier script, or the one it starts, answering with what it came to
 * in words, and the task to send with the next, null once it finished it.
 */
export function handleAgentScriptRoute(request: AgentRequest): Promise<Result<ScriptRun, ApiError>> {
	return Do(async ($) => {
		const {code, task} = $(parseSchema(runScriptBodySchema, request.body ?? {}));
		return await runAgentScript(request.agent, code, task?.trim() || null, 'web');
	});
}
