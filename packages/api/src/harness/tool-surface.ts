import {Err, Ok, type Result} from 'ts-results-es';

import type {HarnessTool, ToolAnswer, ToolSurface} from '@proxy/backends/harness/backend';
import {type ApiError, Do, requirePresent} from '@proxy/utils';
import {callArguments, isRecord, personMessageArgs, SEND_TO_PERSON_TOOL, SLEEP_TOOL, sleepUntil, type ToolCall} from '@proxy/utils/harness';
import {EVENT_LEAD} from '@proxy/utils/harness-context';
import type {EntryRow, InlineJob, ThreadRow} from '@proxy/db/harness';

import type {ModelTool} from '../llm/open-router';
import {SCRIPT_TOOL, scriptToolDescription} from '../mcp/tools';
import {CANCEL_ALERT_TOOL, DISMISS_TOOL, SET_ALERT_PARAMETERS, SET_ALERT_TOOL} from './alerts';
import {BAD_PERSON_MESSAGE_ARGS, jobLost, SENT_TO_PERSON} from './thread-rules';
import type {HarnessStore} from './store';
import {alertCall, BAD_SLEEP_ARGS, dismissText, error, NOT_JSON, noSuchTool, runGateTool, setText, type ToolAnswerStore} from './tool-answers';

/**
 * The tools a thread's agent has: the MCP server's script, as any agent gets it, less starting and
 * finishing tasks, since every call it makes is for the thread's own task and the loop fills it in
 * (tool-answers.ts); a message to the person while it goes on, which is answered at once, the call
 * being what the person reads; a sleep; and an alert, a wake-up of the thread at a time or when
 * something new in the person's accounts carries certain words, set or cancelled. Nothing else:
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
 *
 * What came into the thread while the turn runs, the person's messages and alerts' events, waits
 * pending for the turn's end (db/harness). A call run inline is answered with it besides
 * (`ToolAnswer.meanwhile`), each once in the turn, so the person can steer a turn under way: the
 * ids of what each call's answer carried are kept in `delivered`, by the call's id, for the worker
 * to put it in the log after the call's result as it writes that (inference.ts). A call that ends
 * the turn carries nothing, since the model won't go on to read it, and a message with files waits
 * for the turn's end, where the model is given them with it. Where what came can't be read, the
 * answer goes without it, and it waits too.
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

const SET_ALERT: ModelTool = {
	name: SET_ALERT_TOOL,
	description:
		'Sets an alert, which comes to you as a message and is on the person’s Alerts page: at `at`; or, for a watch, for each new record in `collection` containing any of `terms`. Choose `opens`: this_thread wakes this thread, for a follow-up of its work (check back Friday, remind them after the call); new_thread opens a new thread in the chat each time, for a standing rule or work of its own (whenever X emails, every Monday), whose agent knows only the brief. A new_thread alert may repeat (`every`), and a new_thread watch needs `split`. Terms match as written, not by meaning: give the ways it may be written, concrete ones such as a sender’s address. To change an alert, cancel it and set a new one.',
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

const DISMISS: ModelTool = {
	name: DISMISS_TOOL,
	description:
		'Dismisses this thread, which an alert opened, where what came is nothing the person needs to know: it is archived without telling them, and your turn ends. Otherwise, answer as usual.',
	parameters: {type: 'object', properties: {}, additionalProperties: false},
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

/** The tools a thread's agent is given: the MCP server's script, a message to the person, a sleep, and setting an alert and cancelling one. */
export const THREAD_TOOLS: ModelTool[] = [SCRIPT, SEND_TO_PERSON, SLEEP, SET_ALERT, CANCEL_ALERT];

/** The tools of the thread's agent: a thread's, and, in one an alert opened, dismissing it. */
export function threadTools(thread: ThreadRow): ModelTool[] {
	return thread.openedByAlert ? [...THREAD_TOOLS, DISMISS] : THREAD_TOOLS;
}

// A tool as the harness is given it. None only reads: a script may change something, and the
// rest tell or set something.
function toHarnessTool(tool: ModelTool): HarnessTool {
	return {name: tool.name, description: tool.description, inputSchema: tool.parameters, readOnly: false};
}

/** What running a call inline needs of the store: what answering one needs, the fenced writes beside the log, and what came into the thread meanwhile. */
export type ToolSurfaceStore = ToolAnswerStore & Pick<HarnessStore, 'setAlertInline' | 'scheduleWake' | 'dismissThreadInline' | 'listPendingMessages'>;

/** What each call run inline was answered with besides, by the call's id: the ids of what came into the thread meanwhile, in order. */
export type Delivered = Map<string, string[]>;

// What came into the thread as the model reads it: what the person said, or an event with its
// lead-in.
function asRead(entry: EntryRow): string {
	return entry.kind === 'event' ? `${EVENT_LEAD}\n\n${entry.text}` : entry.text;
}

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

// A dismissal, at once: the thread archived where an alert opened it, the answer ending the turn.
function dismissInline(store: ToolSurfaceStore, thread: ThreadRow, job: InlineJob): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		if (!thread.openedByAlert) {
			return dismissText(false);
		}
		if (!$(await store.dismissThreadInline(job))) {
			return $(Err(jobLost()));
		}
		return {...dismissText(true), endTurn: true};
	});
}

// What a call does, at once: the person told, which is the call itself, read where the thread is
// shown, so nothing is written for it; a sleep as a wake job, the answer ending the turn; an alert
// set or cancelled; or a script run.
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
		if (call.name === DISMISS_TOOL) {
			return $(await dismissInline(store, thread, job));
		}
		if (isGateTool(call.name)) {
			return $(await runGateTool(store, thread, args));
		}
		return noSuchTool(call.name);
	});
}

// The answer with what came into the thread meanwhile that no answer of the turn carried yet,
// those ids kept for the call; the answer as it is where nothing came, the call ends the turn, or
// what came can't be read.
async function withMeanwhile(store: ToolSurfaceStore, thread: ThreadRow, callId: string, answer: ToolAnswer, delivered: Delivered): Promise<ToolAnswer> {
	if (answer.endTurn) {
		return answer;
	}
	const pending = await store.listPendingMessages(thread.id);
	if (pending.isErr()) {
		return answer;
	}
	const given = new Set([...delivered.values()].flat());
	const fresh = pending.value.filter((entry) => !given.has(entry.id));
	if (fresh.length === 0) {
		return answer;
	}
	delivered.set(
		callId,
		fresh.map((entry) => entry.id),
	);
	return {...answer, meanwhile: fresh.map(asRead)};
}

/**
 * The thread's tools as a surface for the harness running `job`, the thread's inference job
 * leased to `workerId`: the model's tools, and `execute`, which runs one inline as the module
 * comment says, at the time `clock` tells as the call is made: a turn goes on for minutes, and a
 * sleep or an alert counted from when it began would be due before it was asked for. What came
 * into the thread meanwhile goes with an answer, its ids kept in `delivered`.
 */
export function toolSurfaceFor(store: ToolSurfaceStore, thread: ThreadRow, job: {id: string}, workerId: string, clock: () => Date, delivered: Delivered = new Map()): ToolSurface {
	const inlineJob: InlineJob = {jobId: job.id, workerId, threadId: thread.id};
	return {
		tools: threadTools(thread).map(toHarnessTool),
		execute: async (call) => {
			const args = callArguments(call);
			if (!isRecord(args)) {
				return Ok(error(NOT_JSON));
			}
			const answer = await execute(store, thread, inlineJob, call, args, clock());
			if (answer.isErr()) {
				return answer;
			}
			return Ok(await withMeanwhile(store, thread, call.id, answer.value, delivered));
		},
	};
}

/** Whether a tool call is a script, whose calls go through the gate. */
export function isGateTool(name: string): boolean {
	return name === SCRIPT_TOOL;
}
