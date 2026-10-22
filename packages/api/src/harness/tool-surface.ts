import {SLEEP_TOOL} from '@proxy/utils/harness';

import {MCP_TOOLS, type McpToolDefinition} from '../mcp/tools';
import type {ModelTool} from './model';

/**
 * The tools the built-in agent has: the MCP server's, as any agent gets them, less the two about
 * tasks, since every call in a thread is for the thread's task and the loop fills the task in
 * (inference.ts, tool-job.ts); and one of its own, to be woken later. Nothing else: everything it
 * does to the person's accounts goes through the same gate as Claude's calls.
 */

// The MCP tools the built-in agent doesn't need: its task is the thread's.
const TASK_TOOLS = new Set(['start_task', 'finish_task']);

const SLEEP: ModelTool = {
	name: SLEEP_TOOL,
	description:
		'Stops until a time, then wakes you with a note of the time. For checking back on something later, or doing what the person asked for at a time they named. Give `until`, the time to wake at, in ISO 8601 with its offset, or `seconds` from now; at most a week. Say what you will do when you wake in your message, since it is all you will have then.',
	parameters: {
		type: 'object',
		properties: {
			until: {type: 'string', description: 'When to wake, in ISO 8601, such as 2026-10-22T07:30:00-07:00'},
			seconds: {type: 'number', description: 'How many seconds from now to wake, instead of until'},
		},
		additionalProperties: false,
	},
};

// What the tools that take a task are for, said without it; every other tool keeps the MCP
// server's words.
const DESCRIPTIONS: Record<string, string> = {
	list_connections:
		'Call this before telling the person a service isn’t connected: their email, meeting notes, documents or issues may well be here. The accounts and information you can use, such as a mailbox or the person’s vault, each with its id and what you may do with it.',
	list_tools: 'The tools you have with one connection: each one’s name, what it does, whether it runs with read or run, its risk, and the JSON Schema of its params. Take `connection` from list_connections.',
	read: 'Runs a tool that only reads, such as listing or opening emails: never changes anything. Take `connection` from list_connections and `tool` from list_tools.',
	run: 'Runs a tool that changes something or reaches other people, such as archiving an email, saving a draft or sending one. Take `connection` from list_connections and `tool` from list_tools.',
};

// The MCP tool without its `task` param, which the loop fills in.
function withoutTask(tool: McpToolDefinition): ModelTool {
	const {task: _task, ...properties} = tool.inputSchema.properties;
	return {
		name: tool.name,
		description: DESCRIPTIONS[tool.name] ?? tool.description,
		parameters: {...tool.inputSchema, properties, required: tool.inputSchema.required.filter((name) => name !== 'task')},
	};
}

/** The tools the model is given, in the order the MCP server lists its. */
export const MODEL_TOOLS: ModelTool[] = [...MCP_TOOLS.filter((tool) => !TASK_TOOLS.has(tool.name)).map(withoutTask), SLEEP];

/** Whether a tool call is for one of the MCP server's tools, run through the gate. */
export function isGateTool(name: string): boolean {
	return MCP_TOOLS.some((tool) => tool.name === name && !TASK_TOOLS.has(tool.name));
}
