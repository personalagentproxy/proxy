import {CREATE_SUBAGENT_TOOL, SEND_TO_PARENT_TOOL, SEND_TO_SUBAGENT_TOOL, SLEEP_TOOL} from '@proxy/utils/harness';

import type {ModelTool} from '../llm/open-router';
import {SCRIPT_TOOL, scriptToolDescription} from '../mcp/tools';
import {CANCEL_ALERT_TOOL, SET_ALERT_PARAMETERS, SET_ALERT_TOOL} from './alerts';

/**
 * The tools the built-in agent has. The agent talking with the person has four: to start a
 * sub-agent on a brief, to send a message to one it started, which keeps what it did and found
 * and takes the message up, to set an alert, a wake-up outside the conversation, at a time or when
 * something new in the person's accounts carries certain words, and to cancel one. A sub-agent has
 * the MCP server's script, as any agent gets it, less starting and finishing tasks, since every
 * call it makes is for its own task and the loop fills it in (tool-job.ts); and two of its own, to
 * send a message to the agent it works for, and to be woken later. Nothing else: everything done
 * to the person's accounts goes through the same gate as Claude's calls.
 */

const CREATE_SUBAGENT: ModelTool = {
	name: CREATE_SUBAGENT_TOOL,
	description: 'Starts a sub-agent with your access on a piece of work and answers with its id. It knows only its brief and your messages; what it says comes to you as a message.',
	parameters: {
		type: 'object',
		properties: {
			title: {type: 'string', description: 'A few words, which the person sees'},
			brief: {
				type: 'string',
				description: 'Everything it needs, and what to report back',
			},
		},
		required: ['title', 'brief'],
		additionalProperties: false,
	},
};

const SEND_TO_SUBAGENT: ModelTool = {
	name: SEND_TO_SUBAGENT_TOOL,
	description: 'Sends a sub-agent a message: an answer, more work or a change. It keeps what it did, so say only what is new; a stopped or asleep one is taken up again.',
	parameters: {
		type: 'object',
		properties: {
			subagent: {type: 'string', description: 'Its id'},
			text: {type: 'string', description: 'The message'},
		},
		required: ['subagent', 'text'],
		additionalProperties: false,
	},
};

const SEND_TO_PARENT: ModelTool = {
	name: SEND_TO_PARENT_TOOL,
	description: 'Tells the agent you work for something while you go on: progress on long work, or what it should know now. Not for a question you need answered, nor for what your answer will say.',
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
	description: 'Sleeps until `until`, ISO 8601 with offset, or for `seconds`, at most a week; a message wakes you sooner. You wake with only this log, so say first what you will do then.',
	parameters: {
		type: 'object',
		properties: {
			until: {type: 'string', description: 'ISO 8601, such as 2026-10-22T07:30:00-07:00'},
			seconds: {type: 'number', description: 'Seconds from now, instead of until'},
		},
		additionalProperties: false,
	},
};

const SET_ALERT: ModelTool = {
	name: SET_ALERT_TOOL,
	description:
		'Sets an alert, which comes to you as a message and is on the person’s Alerts page: at `at`, once; or, for a watch, for each new record in `collection` containing any of `terms`. Terms match as written, not by meaning: give the ways it may be written, concrete ones such as a sender’s address. To change an alert, cancel it and set a new one.',
	parameters: SET_ALERT_PARAMETERS,
};

const CANCEL_ALERT: ModelTool = {
	name: CANCEL_ALERT_TOOL,
	description: 'Cancels an alert by its id.',
	parameters: {
		type: 'object',
		properties: {id: {type: 'string', description: 'The alert’s id'}},
		required: ['id'],
		additionalProperties: false,
	},
};

// The script tool without its `task` param, which the loop fills in, and without starting or
// finishing a task, which the loop does.
const SCRIPT: ModelTool = {
	name: SCRIPT_TOOL,
	description: scriptToolDescription(false),
	parameters: {
		type: 'object',
		properties: {code: {type: 'string', description: 'The script'}},
		required: ['code'],
		additionalProperties: false,
	},
};

/** The tools the agent talking with the person is given: starting a sub-agent and messaging one, setting an alert and cancelling one, and nothing else. */
export const MAIN_AGENT_TOOLS: ModelTool[] = [CREATE_SUBAGENT, SEND_TO_SUBAGENT, SET_ALERT, CANCEL_ALERT];

/** The tools a sub-agent is given: the MCP server's script, a message to the agent it works for, and a sleep. */
export const SUB_AGENT_TOOLS: ModelTool[] = [SCRIPT, SEND_TO_PARENT, SLEEP];

/** The tools the model is given on a thread: a sub-agent's, or the main agent's. */
export function toolsFor(thread: {parentThreadId: string | null}): ModelTool[] {
	return thread.parentThreadId === null ? MAIN_AGENT_TOOLS : SUB_AGENT_TOOLS;
}

/** Whether a tool call is a script, whose calls go through the gate. */
export function isGateTool(name: string): boolean {
	return name === SCRIPT_TOOL;
}
