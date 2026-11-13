import {Err, Ok, type Result} from 'ts-results-es';

import type {HarnessTool, ToolAnswer, ToolSurface} from '@proxy/backends/harness/backend';
import {type ApiError, Do, requirePresent} from '@proxy/utils';
import {
	callArguments,
	CREATE_SUBAGENT_TOOL,
	isRecord,
	parentMessageArgs,
	SEND_TO_PARENT_TOOL,
	SEND_TO_PERSON_TOOL,
	SEND_TO_SUBAGENT_TOOL,
	SLEEP_TOOL,
	sleepUntil,
	subAgentArgs,
	subAgentMessageArgs,
	threadRole,
	type ToolCall,
} from '@proxy/utils/harness';
import type {InlineJob, ThreadRow} from '@proxy/db/harness';

import type {ModelTool} from '../llm/open-router';
import {SCRIPT_TOOL, scriptToolDescription} from '../mcp/tools';
import {CANCEL_ALERT_TOOL, SET_ALERT_PARAMETERS, SET_ALERT_TOOL} from './alerts';
import {
	BAD_PARENT_MESSAGE_ARGS,
	BAD_PERSON_MESSAGE_ARGS,
	BAD_SUBAGENT_ARGS,
	BAD_SUBAGENT_MESSAGE_ARGS,
	jobLost,
	SENT_TO_PARENT,
	SENT_TO_PERSON,
	sentToSubAgent,
	started,
	subAgentStart,
} from './conversation';
import type {HarnessStore} from './store';
import {alertCall, BAD_SLEEP_ARGS, error, NOT_JSON, noSuchTool, runGateTool, setText, type ToolAnswerStore} from './tool-answers';

/**
 * The tools the built-in agent has. The agent talking with the person has four: to start a
 * sub-agent on a brief, to send a message to one it started, which keeps what it did and found
 * and takes the message up, to set an alert, a wake-up outside the conversation, at a time or when
 * something new in the person's accounts carries certain words, and to cancel one. A sub-agent has
 * the MCP server's script, as any agent gets it, less starting and finishing tasks, since every
 * call it makes is for its own task and the loop fills it in (tool-answers.ts); and two of its
 * own, to send a message to the agent it works for, and to be woken later. A chat's thread, whose
 * agent works on the member's message itself, has the script, a sleep and the alerts, and a
 * message to the person while it goes on, which is answered at once: the call is what the person
 * reads. Nothing else: everything done to the person's accounts goes through the same gate as
 * Claude's calls.
 *
 * The harness (@proxy/backends/harness) is given them as a surface: the tools, none of which only
 * reads, since a script may change something, and `execute`, which runs one inline, mid-turn, for
 * a harness that runs its tools itself; a harness that leaves its calls open never calls it, and
 * the api runs each as a job (tool-job.ts). `execute` does what the job and the answer's plans
 * (conversation.ts planCall) do for the call, at once and in a transaction of its own, fenced by
 * the turn's job: a script, its calls through the gate; an alert set or cancelled; a sub-agent
 * started or messaged, or the agent a sub-agent works for told; a sleep as a wake job for the
 * thread, the answer ending the turn. It never writes to the log: what the call answered is the
 * worker's to write, from the `tool_result` event the harness yields for it (inference.ts), after
 * what the model said at the step, so the log reads in order. An alert is therefore set in its own
 * transaction, no longer the one that answers the call: a turn that is tried again after the
 * worker died is given what the log has of the attempt before, the call and its answer among it,
 * or its closing as interrupted (inference.ts), so the call is not run again unless the model
 * calls again, and nothing is set twice.
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
	description:
		'Sends a sub-agent a message about its work: a follow-up, an answer, an update or a change. A new request is a new sub-agent’s. It keeps what it did, so say only what is new; a stopped or asleep one is taken up again.',
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

const SEND_TO_PERSON: ModelTool = {
	name: SEND_TO_PERSON_TOOL,
	description: 'Tells the person something while you go on: progress on long work, or what they should know now. Not for a question you need answered, nor for what your answer will say.',
	parameters: {
		type: 'object',
		properties: {
			text: {type: 'string', description: 'The message, in short Markdown'},
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
	description: scriptToolDescription('harness'),
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

/** The tools a chat's thread is given: the MCP server's script, a message to the person, a sleep, and setting an alert and cancelling one. */
export const THREAD_TOOLS: ModelTool[] = [SCRIPT, SEND_TO_PERSON, SLEEP, SET_ALERT, CANCEL_ALERT];

/** The tools the model is given on a thread: the main agent's, a chat thread's, or a sub-agent's. */
export function toolsFor(thread: {parentThreadId: string | null; parentCallId: string | null}): ModelTool[] {
	const role = threadRole(thread);
	if (role === 'chat') {
		return MAIN_AGENT_TOOLS;
	}
	if (role === 'thread') {
		return THREAD_TOOLS;
	}
	return SUB_AGENT_TOOLS;
}

// A tool as the harness is given it. None only reads: a script may change something, and the
// rest start, tell or set something.
function toHarnessTool(tool: ModelTool): HarnessTool {
	return {name: tool.name, description: tool.description, inputSchema: tool.parameters, readOnly: false};
}

/** What running a call inline needs of the store: what answering one needs, and the fenced writes beside the log. */
export type ToolSurfaceStore = ToolAnswerStore & Pick<HarnessStore, 'setAlertInline' | 'scheduleWake' | 'startSubAgentInline' | 'messageSubAgentInline' | 'tellParentInline'>;

// An alert call, at once: one set, in a transaction of its own fenced by the job, or cancelled.
function alertInline(store: ToolSurfaceStore, thread: ThreadRow, job: InlineJob, call: ToolCall, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const outcome = $(await alertCall(store, thread, call, args, now));
		if (!('alert' in outcome)) {
			return outcome;
		}
		const alert = $(requirePresent($(await store.setAlertInline(job, outcome.alert)), jobLost()));
		return {text: setText(alert), isError: false};
	});
}

// A sleep, at once: a wake job for the thread, the answer ending the turn.
function sleepInline(store: ToolSurfaceStore, job: InlineJob, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const until = sleepUntil(args, now);
		if (until === null) {
			return error(BAD_SLEEP_ARGS);
		}
		if (!$(await store.scheduleWake(job.jobId, job.workerId, job.threadId, until))) {
			return $(Err(jobLost()));
		}
		return {text: `Sleeping until ${until.toISOString()}. You will be woken then, or earlier by a message.`, isError: false, endTurn: true};
	});
}

// What a call of the agent talking with the person does, at once: an alert set or cancelled, a
// sub-agent started or messaged.
function executeMain(store: ToolSurfaceStore, thread: ThreadRow, job: InlineJob, call: ToolCall, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		if (call.name === SET_ALERT_TOOL || call.name === CANCEL_ALERT_TOOL) {
			return $(await alertInline(store, thread, job, call, args, now));
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
// the answer ending the turn, or a script run.
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
			return $(await sleepInline(store, job, args, now));
		}
		if (isGateTool(call.name)) {
			return $(await runGateTool(store, thread, args));
		}
		return noSuchTool(call.name);
	});
}

// What a call of a chat thread's does, at once: the person told, which is the call itself, read
// where the thread is shown, so nothing is written for it; a sleep as a wake job, the answer
// ending the turn; an alert set or cancelled; or a script run.
function executeThread(store: ToolSurfaceStore, thread: ThreadRow, job: InlineJob, call: ToolCall, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		if (call.name === SEND_TO_PERSON_TOOL) {
			return parentMessageArgs(args) ? {text: SENT_TO_PERSON, isError: false} : error(BAD_PERSON_MESSAGE_ARGS);
		}
		if (call.name === SLEEP_TOOL) {
			return $(await sleepInline(store, job, args, now));
		}
		if (call.name === SET_ALERT_TOOL || call.name === CANCEL_ALERT_TOOL) {
			return $(await alertInline(store, thread, job, call, args, now));
		}
		if (isGateTool(call.name)) {
			return $(await runGateTool(store, thread, args));
		}
		return noSuchTool(call.name);
	});
}

/**
 * The thread's tools as a surface for the harness running `job`, the thread's inference job
 * leased to `workerId`: the model's tools, and `execute`, which runs one inline as the module
 * comment says, at the time `clock` tells as the call is made: a turn goes on for minutes, and a
 * sleep or an alert counted from when it began would be due before it was asked for.
 */
export function toolSurfaceFor(store: ToolSurfaceStore, thread: ThreadRow, job: {id: string}, workerId: string, clock: () => Date): ToolSurface {
	const inlineJob: InlineJob = {jobId: job.id, workerId, threadId: thread.id};
	return {
		tools: toolsFor(thread).map(toHarnessTool),
		execute: (call) => {
			const args = callArguments(call);
			if (!isRecord(args)) {
				return Promise.resolve(Ok(error(NOT_JSON)));
			}
			const role = threadRole(thread);
			if (role === 'chat') {
				return executeMain(store, thread, inlineJob, call, args, clock());
			}
			if (role === 'thread') {
				return executeThread(store, thread, inlineJob, call, args, clock());
			}
			return executeSub(store, thread, inlineJob, call, args, clock());
		},
	};
}

/** Whether a tool call is a script, whose calls go through the gate. */
export function isGateTool(name: string): boolean {
	return name === SCRIPT_TOOL;
}
