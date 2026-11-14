import {Err, Ok, type Result} from 'ts-results-es';

import type {HarnessTool, ToolAnswer, ToolSurface} from '@proxy/backends/harness/backend';
import {type ApiError, Do, requirePresent} from '@proxy/utils';
import {callArguments, isRecord, personMessageArgs, SEND_TO_PERSON_TOOL, SLEEP_TOOL, sleepUntil, START_THREAD_TOOL, type ToolCall} from '@proxy/utils/harness';
import type {InlineJob, ThreadRow} from '@proxy/db/harness';

import type {ModelTool} from '../llm/open-router';
import {SCRIPT_TOOL, scriptToolDescription} from '../mcp/tools';
import {CANCEL_ALERT_TOOL, SET_ALERT_PARAMETERS, SET_ALERT_TOOL} from './alerts';
import {type StartThreadStore, startThreadCall} from './start-thread';
import {BAD_PERSON_MESSAGE_ARGS, jobLost, SENT_TO_PERSON} from './thread-rules';
import type {HarnessStore} from './store';
import {alertCall, BAD_SLEEP_ARGS, error, NOT_JSON, noSuchTool, runGateTool, setText, type ToolAnswerStore} from './tool-answers';

/**
 * The tools a thread's agent has: the MCP server's script, as any agent gets it, less starting and
 * finishing tasks, since every call it makes is for the thread's own task and the loop fills it in
 * (tool-answers.ts); a message to the person while it goes on, which is answered at once, the call
 * being what the person reads; a sleep; and an alert, a wake-up of the thread at a time or when
 * something new in the person's accounts carries certain words, set or cancelled; and a new thread
 * in the person's chat, for a piece of work apart from this one (start-thread.ts). Nothing else:
 * everything done to the person's accounts goes through the same gate as Claude's calls.
 *
 * The harness (@proxy/backends/harness) is given them as a surface: the tools, none of which only
 * reads, since a script may change something, and `execute`, which runs one inline, mid-turn, for
 * a harness that runs its tools itself; a harness that leaves its calls open never calls it, and
 * the api runs each as a job (tool-job.ts). `execute` does what the job and the answer's plans
 * (thread-rules.ts planCall) do for the call, at once and in a transaction of its own, fenced by
 * the turn's job: a script, its calls through the gate; an alert set or cancelled; a sleep as a
 * wake job for the thread, the answer ending the turn. It never writes to the log: what the call
 * answered is the worker's to write, from the `tool_result` event the harness yields for it
 * (inference.ts), after what the model said at the step, so the log reads in order. An alert is
 * therefore set in its own transaction, no longer the one that answers the call: a turn that is
 * tried again after the worker died is given what the log has of the attempt before, the call and
 * its answer among it, or its closing as interrupted (inference.ts), so the call is not run again
 * unless the model calls again, and nothing is set twice.
 */

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

const START_THREAD: ModelTool = {
	name: START_THREAD_TOOL,
	description:
		'Starts a new thread in the person’s chat with you, for a piece of work apart from this one: `text` opens it as the person’s message would, so write it as they would ask, with all it needs, since its own agent begins on it at once knowing nothing else of this thread. The person sees it in their chat, marked as started from another thread. Only when the person asked for it, or for something that is not this thread’s work; say in your answer that you did, with its link.',
	parameters: {
		type: 'object',
		properties: {
			text: {type: 'string', description: 'The message that opens the thread, as the person would write it, in Markdown'},
		},
		required: ['text'],
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
	description: 'Cancels one of the person’s alerts by its id, whichever thread it was set in.',
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

/** The tools a thread's agent is given: the MCP server's script, a message to the person, a sleep, setting an alert and cancelling one, and starting another thread. */
export const THREAD_TOOLS: ModelTool[] = [SCRIPT, SEND_TO_PERSON, SLEEP, SET_ALERT, CANCEL_ALERT, START_THREAD];

// A tool as the harness is given it. None only reads: a script may change something, and the
// rest tell or set something.
function toHarnessTool(tool: ModelTool): HarnessTool {
	return {name: tool.name, description: tool.description, inputSchema: tool.parameters, readOnly: false};
}

/** What running a call inline needs of the store: what answering one needs, and the fenced writes beside the log. */
export type ToolSurfaceStore = ToolAnswerStore & StartThreadStore & Pick<HarnessStore, 'setAlertInline' | 'scheduleWake'>;

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

// What a call does, at once: the person told, which is the call itself, read where the thread is
// shown, so nothing is written for it; a sleep as a wake job, the answer ending the turn; an alert
// set or cancelled; a thread started; or a script run.
function execute(store: ToolSurfaceStore, thread: ThreadRow, job: InlineJob, call: ToolCall, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		if (call.name === SEND_TO_PERSON_TOOL) {
			return personMessageArgs(args) ? {text: SENT_TO_PERSON, isError: false} : error(BAD_PERSON_MESSAGE_ARGS);
		}
		if (call.name === SLEEP_TOOL) {
			return $(await sleepInline(store, job, args, now));
		}
		if (call.name === SET_ALERT_TOOL || call.name === CANCEL_ALERT_TOOL) {
			return $(await alertInline(store, thread, job, call, args, now));
		}
		if (call.name === START_THREAD_TOOL) {
			return $(await startThreadCall(store, thread, args));
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
		tools: THREAD_TOOLS.map(toHarnessTool),
		execute: (call) => {
			const args = callArguments(call);
			if (!isRecord(args)) {
				return Promise.resolve(Ok(error(NOT_JSON)));
			}
			return execute(store, thread, inlineJob, call, args, clock());
		},
	};
}

/** Whether a tool call is a script, whose calls go through the gate. */
export function isGateTool(name: string): boolean {
	return name === SCRIPT_TOOL;
}
