import {ANY_FIELD, CANCEL_ALERT_TOOL, SET_ALERT_TOOL, WATCH_COLLECTIONS} from '@proxy/utils/alerts';
import {DELEGATE_TOOL, SLEEP_TOOL} from '@proxy/utils/harness';

import type {ModelTool} from '../llm/open-router';
import {MCP_TOOLS, type McpToolDefinition} from '../mcp/tools';

/**
 * The tools the built-in agent has. The agent talking with the person has three: to delegate a
 * piece of work to a sub-agent, which reports back; to set an alert, a wake-up outside the
 * conversation, at a time or a watch on the person's accounts; and to end one. A sub-agent has
 * the MCP server's, as any agent gets them, less the two about tasks, since every call it makes
 * is for its own task and the loop fills it in (tool-job.ts); and one of its own, to be woken
 * later. Nothing else: everything done to the person's accounts goes through the same gate as
 * Claude's calls.
 */

// The MCP tools a sub-agent doesn't need: its task is its own.
const TASK_TOOLS = new Set(['start_task', 'finish_task']);

const DELEGATE: ModelTool = {
	name: DELEGATE_TOOL,
	description:
		'Starts a sub-agent on a piece of work with the person’s accounts, with the same access as you. It answers at once that the sub-agent has started, and the sub-agent’s report comes to you as a message when it is done: go on meanwhile, or, when there is nothing to do until then, tell the person what you are looking into and stop. Give `title`, what the work is in a few words, which the person sees, and `brief`, everything the sub-agent needs: it knows nothing of this conversation but the brief, and can’t ask you or the person anything. One sub-agent can look in several accounts: start another only for a separate piece of work.',
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

const SLEEP: ModelTool = {
	name: SLEEP_TOOL,
	description:
		'Stops until a time, then wakes you with a note of the time. For checking back on something later, or doing what the brief asks for at a time it named. Give `until`, the time to wake at, in ISO 8601 with its offset, or `seconds` from now; at most a week. Say what you will do when you wake in your message, since it is all you will have then.',
	parameters: {
		type: 'object',
		properties: {
			until: {type: 'string', description: 'When to wake, in ISO 8601, such as 2026-10-22T07:30:00-07:00'},
			seconds: {type: 'number', description: 'How many seconds from now to wake, instead of until'},
		},
		additionalProperties: false,
	},
};

// The fields a watch's criteria can name, per collection, as the tool tells the model.
const WATCH_FIELDS = Object.entries(WATCH_COLLECTIONS)
	.map(([id, collection]) => `${id}: ${[...collection.fields, ANY_FIELD].join(', ')}`)
	.join('; ');

const SET_ALERT: ModelTool = {
	name: SET_ALERT_TOOL,
	description: `Sets an alert: a wake-up outside this conversation, which comes to you as a message when it is due, for you to tell the person or act on; the person sees it on their Alerts page. Give \`title\`, what it is in a few words, \`brief\`, what you noted for it, and either \`at\`, a time in ISO 8601 with its offset, for one message at that time, the brief being what to tell the person then or what to do; or \`collection\`, for a watch: the person’s connections with that collection are looked at every ten minutes for what is new or changed, and each new record that says what \`match\` asks comes to you as a message, with its link. \`match\` is a list of conditions, all of which must hold, each a field and the words or phrases any of which it must contain, matched as written, not understood: {"field": "from", "terms": ["@bank.com"]}, {"field": "subject", "terms": ["loan", "mortgage"]}; the fields are ${WATCH_FIELDS}, \`any\` being every field. Give several terms for the ways a thing may be written, and concrete ones: the person’s own name or address for “me”, as the connection shows them. No conditions matches everything new. \`connections\` narrows the watch to some of the person’s connections, by id, as your instructions list them; left out, it is every connection you may read that has the collection.`,
	parameters: {
		type: 'object',
		properties: {
			title: {type: 'string', description: 'What the alert is, in a few words, such as "Reply from the landlord"'},
			brief: {
				type: 'string',
				description: 'What you noted for it: for a time, what to tell the person then or what to do; for a watch, what it is for, in words, which you are reminded of with each match',
			},
			at: {type: 'string', description: 'When to be woken once, in ISO 8601 with its offset, such as 2026-10-22T07:30:00-07:00'},
			collection: {type: 'string', description: `What to watch: one of ${Object.keys(WATCH_COLLECTIONS).join(', ')}`},
			connections: {type: 'array', items: {type: 'string'}, description: 'The connections to watch, by id; left out for every one you may read with the collection'},
			match: {
				type: 'array',
				items: {
					type: 'object',
					properties: {field: {type: 'string'}, terms: {type: 'array', items: {type: 'string'}}},
					required: ['field', 'terms'],
					additionalProperties: false,
				},
				description: 'The conditions a record must meet, all of them: each a field of the collection and the terms any of which it must contain. Left out, everything new matches.',
			},
		},
		required: ['title', 'brief'],
		additionalProperties: false,
	},
};

const CANCEL_ALERT: ModelTool = {
	name: CANCEL_ALERT_TOOL,
	description: 'Ends one of the alerts set in this conversation, by its id, as your instructions list them.',
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

/** The tools the agent talking with the person is given: delegating, setting an alert and ending one, and nothing else. */
export const MAIN_AGENT_TOOLS: ModelTool[] = [DELEGATE, SET_ALERT, CANCEL_ALERT];

/** The tools a sub-agent is given: the MCP server's but the task ones, in the order it lists them, and a sleep. */
export const SUB_AGENT_TOOLS: ModelTool[] = [...MCP_TOOLS.filter((tool) => !TASK_TOOLS.has(tool.name)).map(withoutTask), SLEEP];

/** The tools the model is given on a thread: a sub-agent's, or the main agent's. */
export function toolsFor(thread: {parentThreadId: string | null}): ModelTool[] {
	return thread.parentThreadId === null ? MAIN_AGENT_TOOLS : SUB_AGENT_TOOLS;
}

/** Whether a tool call is for one of the MCP server's tools, run through the gate. */
export function isGateTool(name: string): boolean {
	return MCP_TOOLS.some((tool) => tool.name === name && !TASK_TOOLS.has(tool.name));
}
