import {Err, Ok, type Result} from 'ts-results-es';

import type {HarnessTool, ToolAnswer, ToolSurface} from '@proxy/backends/harness/backend';
import {type ApiError, Do, requirePresent} from '@proxy/utils';
import {
	callArguments,
	CREATE_SUBAGENT_TOOL,
	isRecord,
	parentMessageArgs,
	SEND_TO_PARENT_TOOL,
	SEND_TO_SUBAGENT_TOOL,
	SLEEP_TOOL,
	sleepUntil,
	subAgentArgs,
	subAgentMessageArgs,
	type ToolCall,
} from '@proxy/utils/harness';
import type {InlineJob, ThreadRow} from '@proxy/db/harness';

import type {ModelTool} from '../llm/open-router';
import {MCP_TOOLS, type McpToolDefinition} from '../mcp/tools';
import {CANCEL_ALERT_TOOL, SET_ALERT_PARAMETERS, SET_ALERT_TOOL} from './alerts';
import {BAD_PARENT_MESSAGE_ARGS, BAD_SUBAGENT_ARGS, BAD_SUBAGENT_MESSAGE_ARGS, jobLost, SENT_TO_PARENT, sentToSubAgent, started, subAgentStart} from './conversation';
import type {HarnessStore} from './store';
import {alertCall, BAD_SLEEP_ARGS, error, NOT_JSON, noSuchTool, runGateTool, setText, type ToolAnswerStore} from './tool-answers';

/**
 * The tools the built-in agent has. The agent talking with the person has four: to start a
 * sub-agent on a brief, to send a message to one it started, which keeps what it did and found
 * and takes the message up, to set an alert, a wake-up outside the conversation, at a time or when
 * something new in the person's accounts carries certain words, and to cancel one. A sub-agent has
 * the MCP server's, as any agent gets them, less the two about tasks, since every call it makes is
 * for its own task and the loop fills it in; and two of its own, to send a message to the agent it
 * works for, and to be woken later. Nothing else: everything done to the person's accounts goes
 * through the same gate as Claude's calls.
 *
 * The harness (@proxy/backends/harness) is given them as a surface: the tools, each marked whether
 * it only reads, and `execute`, which runs one inline, mid-turn, for a harness that runs its tools
 * itself; a harness that leaves its calls open never calls it, and the api runs each as a job
 * (tool-job.ts). `execute` does what the job and the answer's plans (conversation.ts planCall) do
 * for the call, at once and in a transaction of its own, fenced by the turn's job: a gate tool
 * through the MCP dispatch; an alert set or cancelled; a sub-agent started or messaged, or the
 * agent a sub-agent works for told; a sleep as a wake job for the thread, the answer ending the
 * turn. It never writes to the log: what the call answered is the worker's to write, from the
 * `tool_result` event the harness yields for it (inference.ts), after what the model said at the
 * step, so the log reads in order. An alert is therefore set in its own transaction, no longer the
 * one that answers the call: a turn that is tried again after the worker died resumes the
 * harness's own session, in which the call was already made and answered, so the call is not run
 * again unless the model calls again, and nothing is set twice.
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

/** What running a call inline needs of the store: what answering one needs, and the fenced writes beside the log. */
export type ToolSurfaceStore = ToolAnswerStore & Pick<HarnessStore, 'setAlertInline' | 'scheduleWake' | 'startSubAgentInline' | 'messageSubAgentInline' | 'tellParentInline'>;

// What a call of the agent talking with the person does, at once: an alert set or cancelled, a
// sub-agent started or messaged.
function executeMain(store: ToolSurfaceStore, thread: ThreadRow, job: InlineJob, call: ToolCall, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		if (call.name === SET_ALERT_TOOL || call.name === CANCEL_ALERT_TOOL) {
			const outcome = $(await alertCall(store, thread, call, args, now));
			if (!('alert' in outcome)) {
				return outcome;
			}
			const alert = $(requirePresent($(await store.setAlertInline(job, outcome.alert)), jobLost()));
			return {text: setText(alert), isError: false};
		}
		if (call.name === CREATE_SUBAGENT_TOOL) {
			const parsed = subAgentArgs(args);
			if (!parsed) {
				return error(BAD_SUBAGENT_ARGS);
			}
			const id = $(requirePresent($(await store.startSubAgentInline(job, subAgentStart(thread, {id: call.id, ...parsed}))), jobLost()));
			return {text: started(parsed.title)(id), isError: false};
		}
		if (call.name === SEND_TO_SUBAGENT_TOOL) {
			const parsed = subAgentMessageArgs(args);
			if (!parsed) {
				return error(BAD_SUBAGENT_MESSAGE_ARGS);
			}
			const sent = $(requirePresent($(await store.messageSubAgentInline(job, parsed.subagent, {kind: 'person', text: parsed.text})), jobLost()));
			return sentToSubAgent(parsed.subagent)(sent.subAgent);
		}
		return noSuchTool(call.name);
	});
}

// What a call of a sub-agent's does, at once: the agent it works for told, a sleep as a wake job,
// the answer ending the turn, or a gate tool run.
function executeSub(store: ToolSurfaceStore, thread: ThreadRow, job: InlineJob, call: ToolCall, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		if (call.name === SEND_TO_PARENT_TOOL) {
			const parsed = parentMessageArgs(args);
			if (!parsed) {
				return error(BAD_PARENT_MESSAGE_ARGS);
			}
			if (!$(await store.tellParentInline(job, {text: parsed.text, isError: false}))) {
				return $(Err(jobLost()));
			}
			return {text: SENT_TO_PARENT, isError: false};
		}
		if (call.name === SLEEP_TOOL) {
			const until = sleepUntil(args, now);
			if (until === null) {
				return error(BAD_SLEEP_ARGS);
			}
			if (!$(await store.scheduleWake(job.jobId, job.workerId, job.threadId, until))) {
				return $(Err(jobLost()));
			}
			return {text: `Sleeping until ${until.toISOString()}. You will be woken then, or earlier by a message.`, isError: false, endTurn: true};
		}
		if (isGateTool(call.name)) {
			return $(await runGateTool(store, thread, call.name, args));
		}
		return noSuchTool(call.name);
	});
}

/**
 * The thread's tools as a surface for the harness running `job`, the thread's inference job
 * leased to `workerId`: the model's tools, and `execute`, which runs one inline as the module
 * comment says, at `now`.
 */
export function toolSurfaceFor(store: ToolSurfaceStore, thread: ThreadRow, job: {id: string}, workerId: string, now: Date): ToolSurface {
	const inlineJob: InlineJob = {jobId: job.id, workerId, threadId: thread.id};
	return {
		tools: toolsFor(thread).map(toHarnessTool),
		execute: (call) => {
			const args = callArguments(call);
			if (!isRecord(args)) {
				return Promise.resolve(Ok(error(NOT_JSON)));
			}
			if (thread.parentThreadId === null) {
				return executeMain(store, thread, inlineJob, call, args, now);
			}
			return executeSub(store, thread, inlineJob, call, args, now);
		},
	};
}

/** Whether a tool call is for one of the MCP server's tools, run through the gate. */
export function isGateTool(name: string): boolean {
	return MCP_TOOLS.some((tool) => tool.name === name && !TASK_TOOLS.has(tool.name));
}
