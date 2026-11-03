import {Err, type Result} from 'ts-results-es';

import {type ApiError, ApiErr, Do, requirePresent} from '@proxy/utils';
import {callArguments, SEND_TO_SUBAGENT_TOOL, SLEEP_TOOL, sleepUntil, subAgentMessageArgs, type ToolCall} from '@proxy/utils/harness';
import type {JobRow, ThreadRow} from '@proxy/db/harness';

import {callMcpTool} from '../mcp/tools';
import {failureNote, subAgentMessage} from './conversation';
import type {HarnessStore} from './store';
import {ensureThreadTask, type ThreadTaskStore} from './thread-task';
import {isGateTool} from './tool-surface';

/**
 * A tool job: one call the model made, run and answered in the log. The agent talking with the
 * person has one call that takes a job, a message to a sub-agent, which lands in the sub-agent's
 * log; starting one is done as the answer is written (conversation.ts planCall). The MCP server's
 * tools go through the gate as the sub-agent acting as the member, for its task, logged like any
 * agent's call. A sleep answers with the time, since its job was due when the sleep ended. A call
 * that changes something is never run twice: a worker that was interrupted mid-call leaves the
 * outcome unknown, and the model is told so rather than the call being made again.
 */

/** What a tool job needs of the store. */
export type ToolJobStore = Pick<HarnessStore, 'getJobThread' | 'getEntry' | 'getThreadAgent' | 'completeToolJob' | 'failJob' | 'finishJob' | 'sendToSubAgent'> & ThreadTaskStore;

// How much of a result the log keeps, and the model reads.
const MAX_RESULT_CHARS = 60_000;

type ToolAnswer = {text: string; isError: boolean};

function error(text: string): ToolAnswer {
	return {text, isError: true};
}

// The call's arguments where they are a JSON object, as a tool takes them.
function parseArgs(call: ToolCall): Record<string, unknown> | null {
	const args = callArguments(call);
	if (typeof args !== 'object' || args === null || Array.isArray(args)) {
		return null;
	}
	return args as Record<string, unknown>;
}

// A result cut to what the log keeps, saying so at its end, so the model knows there was more.
function cutResult(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Cut: the result was ${text.length} characters long.]`;
}

// Runs the call through the gate, as the sub-agent acts in the thread, for its task.
function runGateTool(store: ToolJobStore, thread: ThreadRow, name: string, args: Record<string, unknown>): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const signedIn = $(requirePresent($(await store.getThreadAgent(thread)), ApiErr.notFound('agent', thread.agentId)));
		const taskId = $(await ensureThreadTask(store, thread));
		const result = await callMcpTool(signedIn, name, {...args, task: taskId}, false, 'harness');
		return {text: cutResult(result.content.map((part) => part.text).join('\n')), isError: result.isError === true};
	});
}

// Sends the message to the sub-agent, from the conversation's agent, and says so, with what the
// sub-agent was up to.
function messageSubAgent(store: ToolJobStore, job: JobRow, workerId: string, thread: ThreadRow, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const parsed = subAgentMessageArgs(args);
		if (!parsed) {
			return error('Give subagent, the sub-agent’s id, and text, the message.');
		}
		const sent = $(await store.sendToSubAgent(job.id, workerId, thread, parsed.subagent, subAgentMessage(parsed.text, now)));
		if (sent === false) {
			return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
		}
		if (sent === null) {
			return error(`You have no sub-agent with id ${parsed.subagent}. Your sub-agents and their ids are listed in your instructions.`);
		}
		const was =
			sent.state.kind === 'stopped' ? 'had stopped, and takes it up' : sent.state.kind === 'asleep' ? 'was asleep, and is woken by it' : 'is at work, and reads it when its current call is answered';
		return {text: `Sent to the sub-agent “${sent.title ?? ''}”, which ${was}. What it says back will come to you as a message.`, isError: false};
	});
}

function answer(store: ToolJobStore, thread: ThreadRow, job: JobRow, workerId: string, call: ToolCall, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const args = parseArgs(call);
		if (args === null) {
			return error('The arguments were not a JSON object.');
		}
		if (call.name === SEND_TO_SUBAGENT_TOOL && thread.parentThreadId === null) {
			return $(await messageSubAgent(store, job, workerId, thread, args, now));
		}
		if (call.name === SLEEP_TOOL && thread.parentThreadId !== null) {
			if (sleepUntil(args, now) === null) {
				return error('Give until, a time in ISO 8601, or seconds from now.');
			}
			return {text: `You slept, and it is now ${now.toISOString()}.`, isError: false};
		}
		if (!isGateTool(call.name) || thread.parentThreadId === null) {
			return error(`There is no tool ${call.name}.`);
		}
		// A write run by a worker that lost the job mid-call may have gone through.
		if (call.name === 'run' && job.attempts > 1) {
			return error('The outcome of this call is unknown: the worker running it was interrupted before it could record the answer. Check what it changed before making it again.');
		}
		return $(await runGateTool(store, thread, call.name, args));
	});
}

/** Runs the job: the call it is for, its answer written to the log, and the model woken once every call is answered. */
export function runToolJob(store: ToolJobStore, job: JobRow, workerId: string, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const thread = $(await store.getJobThread(job.threadId));
		if (!thread) {
			$(await store.finishJob(job.id, workerId));
			return;
		}
		const entry = $(await store.getEntry(job.entryId ?? ''));
		const call = entry.toolCalls?.find((candidate) => candidate.id === job.callId);
		if (!call) {
			const error = `No call ${job.callId ?? ''} in entry ${entry.id}`;
			$(await store.failJob(job.id, workerId, error, failureNote(error)));
			return;
		}
		const answered = $(await answer(store, thread, job, workerId, call, now));
		$(await store.completeToolJob(job.id, workerId, thread.id, {callId: call.id, ...answered}));
	});
}
