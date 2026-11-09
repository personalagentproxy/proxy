import {Err} from 'ts-results-es';

import type {HarnessTool, ToolSurface} from '@proxy/backends/harness/backend';
import {ApiErr} from '@proxy/utils';
import {CREATE_SUBAGENT_TOOL, SEND_TO_PARENT_TOOL, SEND_TO_SUBAGENT_TOOL, SLEEP_TOOL} from '@proxy/utils/harness';

import type {ModelTool} from '../llm/open-router';
import {MCP_TOOLS, type McpToolDefinition} from '../mcp/tools';
import {CANCEL_ALERT_TOOL, SET_ALERT_PARAMETERS, SET_ALERT_TOOL} from './alerts';

/**
 * The tools the built-in agent has. The agent talking with the person has four: to start a
 * sub-agent on a brief, to send a message to one it started, which keeps what it did and found
 * and takes the message up, to set an alert, a wake-up outside the conversation, at a time or when
 * something new in the person's accounts carries certain words, and to cancel one. A sub-agent has the MCP server's, as any agent gets them, less
 * the two about tasks, since every call it makes is for its own task and the loop fills it in
 * (tool-job.ts); and two of its own, to send a message to the agent it works for, and to be woken
 * later. Nothing else: everything done to the person's accounts goes through the same gate as
 * Claude's calls. The harness (@proxy/backends/harness) is given them as a surface: the tools, each
 * marked whether it only reads, and a way to run one inline, which no harness this server runs
 * uses yet: every call is run as a job of the api's (tool-job.ts).
 */

// The MCP tools a sub-agent doesn't need: its task is its own.
const TASK_TOOLS = new Set(['start_task', 'finish_task']);

const CREATE_SUBAGENT: ModelTool = {
	name: CREATE_SUBAGENT_TOOL,
	description:
		'Starts a sub-agent on a piece of work with the person’s accounts, with the same access as you, and answers at once with its id. The sub-agent works on its own: what it says to you, a question, how far it has got or what it found, comes to you as a message; when it stops, its last words come too, and it keeps everything it did and found, so send_to_subagent takes it up again rather than starting another. Go on meanwhile, or, when there is nothing to do until it says something, tell the person what you are looking into and stop. Give `title`, what the work is in a few words, which the person sees, and `brief`, everything the sub-agent needs: it knows nothing of this conversation but the brief and what you send it. One sub-agent can look in several accounts: start another only for a separate piece of work.',
	parameters: {
		type: 'object',
		properties: {
			title: {type: 'string', description: 'What the work is, in a few words, such as "Find last week’s invoices"'},
			brief: {
				type: 'string',
				description: 'What to do, with everything the sub-agent needs to know to do it: what the person asked for, what has been found so far, names, ids, dates, and what to report back.',
			},
		},
		required: ['title', 'brief'],
		additionalProperties: false,
	},
};

const SEND_TO_SUBAGENT: ModelTool = {
	name: SEND_TO_SUBAGENT_TOOL,
	description:
		'Sends a message to one of your sub-agents, by the id create_subagent answered with: an answer to its question, more to do, or a change to what it is doing. It has everything it did and found so far, so say only what is new. A sub-agent that had stopped takes the message up again; one that is asleep is woken by it; one at work reads it when its current call is answered. What it says back comes to you as a message. Your sub-agents, with their ids and what each is doing, are listed in your instructions.',
	parameters: {
		type: 'object',
		properties: {
			subagent: {type: 'string', description: 'The sub-agent’s id, as create_subagent answered'},
			text: {type: 'string', description: 'The message'},
		},
		required: ['subagent', 'text'],
		additionalProperties: false,
	},
};

const SEND_TO_PARENT: ModelTool = {
	name: SEND_TO_PARENT_TOOL,
	description:
		'Sends a message to the agent you work for while you go on working: how far you have got where the work takes long, or something found that it should know before you are done. Its answer, when it has one, comes to you as a message. Not for a question you can’t go on without: answer with that question and no tool call, which stops you until the agent replies. Don’t send what your final answer will say: stopping with an answer hands that over by itself.',
	parameters: {
		type: 'object',
		properties: {
			text: {type: 'string', description: 'The message'},
		},
		required: ['text'],
		additionalProperties: false,
	},
};

const SLEEP: ModelTool = {
	name: SLEEP_TOOL,
	description:
		'Stops until a time, then wakes you with a note of the time. For checking back on something later, or doing what the brief asks for at a time it named. Give `until`, the time to wake at, in ISO 8601 with its offset, or `seconds` from now; at most a week. A message from the agent you work for wakes you before then. Say what you will do when you wake in your message, since it is all you will have then.',
	parameters: {
		type: 'object',
		properties: {
			until: {type: 'string', description: 'When to wake, in ISO 8601, such as 2026-10-22T07:30:00-07:00'},
			seconds: {type: 'number', description: 'How many seconds from now to wake, instead of until'},
		},
		additionalProperties: false,
	},
};

const SET_ALERT: ModelTool = {
	name: SET_ALERT_TOOL,
	description:
		'Sets an alert: a wake-up outside this conversation, which comes to you as a message when it is due, for you to tell the person or act on; the person sees it on their Alerts page. Give `title`, what it is in a few words, `brief`, what you noted for it, and either `at`, a time in ISO 8601 with its offset, for one message at that time; or `collection`, for a watch: the person’s connections with that collection are watched for what is new, and each new record that contains any of `terms` comes to you as a message, with its link. Terms are matched as written, not understood: give the ways a thing may be written, and concrete ones, such as the sender’s address rather than “the bank”; no terms matches everything new. `connections` narrows the watch to some of the person’s connections, by id, as your instructions list them; left out, it is every connection you may read that has the collection.',
	parameters: SET_ALERT_PARAMETERS,
};

const CANCEL_ALERT: ModelTool = {
	name: CANCEL_ALERT_TOOL,
	description: 'Cancels one of the alerts set in this conversation, by its id, as your instructions list them.',
	parameters: {
		type: 'object',
		properties: {id: {type: 'string', description: 'The alert’s id'}},
		required: ['id'],
		additionalProperties: false,
	},
};

// What the tools that take a task are for, said without it; every other tool keeps the MCP
// server's words.
const DESCRIPTIONS: Record<string, string> = {
	list_connections:
		'Call this before reporting that a service isn’t connected: the person’s email, meeting notes, documents or issues may well be here. The accounts and information you can use, such as a mailbox or the person’s vault, each with its id and what you may do with it.',
	list_tools:
		'The tools you have with one connection: each one’s name, what it does, whether it runs with read or run, its risk, and the JSON Schema of its params. Take `connection` from list_connections.',
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

/** The tools the agent talking with the person is given: starting a sub-agent and messaging one, setting an alert and cancelling one, and nothing else. */
export const MAIN_AGENT_TOOLS: ModelTool[] = [CREATE_SUBAGENT, SEND_TO_SUBAGENT, SET_ALERT, CANCEL_ALERT];

/** The tools a sub-agent is given: the MCP server's but the task ones, in the order it lists them, a message to the agent it works for, and a sleep. */
export const SUB_AGENT_TOOLS: ModelTool[] = [...MCP_TOOLS.filter((tool) => !TASK_TOOLS.has(tool.name)).map(withoutTask), SEND_TO_PARENT, SLEEP];

/** The tools the model is given on a thread: a sub-agent's, or the main agent's. */
export function toolsFor(thread: {parentThreadId: string | null}): ModelTool[] {
	return thread.parentThreadId === null ? MAIN_AGENT_TOOLS : SUB_AGENT_TOOLS;
}

// The tools that change nothing: reading through the gate, and the two that list what there is.
const READ_ONLY_TOOLS = new Set(['read', 'list_connections', 'list_tools']);

// A tool as the harness is given it.
function toHarnessTool(tool: ModelTool): HarnessTool {
	return {name: tool.name, description: tool.description, inputSchema: tool.parameters, readOnly: READ_ONLY_TOOLS.has(tool.name)};
}

/**
 * The thread's tools as a surface for the harness: the model's tools, and how to run one inline,
 * which answers that it can't, for now: every call a harness leaves open is run as a job
 * (tool-job.ts), and a harness that runs tools itself is still to come, with what `execute` then
 * does.
 */
export function toolSurfaceFor(thread: {parentThreadId: string | null}): ToolSurface {
	return {
		tools: toolsFor(thread).map(toHarnessTool),
		execute: async () => Err(ApiErr.conflict('Calls are run as jobs')),
	};
}

/** Whether a tool call is for one of the MCP server's tools, run through the gate. */
export function isGateTool(name: string): boolean {
	return MCP_TOOLS.some((tool) => tool.name === name && !TASK_TOOLS.has(tool.name));
}
