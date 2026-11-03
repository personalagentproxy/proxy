import {Err, type Result} from 'ts-results-es';

import {type ApiError, ApiErr, Do, requirePresent} from '@proxy/utils';
import {callArguments, DELEGATE_TOOL, delegateArgs, SLEEP_TOOL, sleepUntil, type ToolCall} from '@proxy/utils/harness';
import type {JobRow, ThreadRow} from '@proxy/db/harness';

import {callMcpTool} from '../mcp/tools';
import {failureNote, subAgentStart} from './conversation';
import type {HarnessStore} from './store';
import {ensureThreadTask, type ThreadTaskStore} from './thread-task';
import {isGateTool} from './tool-surface';

/**
 * A tool job: one call the model made, run and answered in the log. A delegation starts the
 * sub-agent, whose report answers the call later; the call was answered as started when it was
 * made (inference.ts). The MCP server's tools go through the gate as the sub-agent acting as the
 * member, for its task, logged like any agent's call. A sleep answers with the time, since its job
 * was due when the sleep ended. A call that changes something is never run twice: a worker that
 * was interrupted mid-call leaves the outcome unknown, and the model is told so rather than the
 * call being made again.
 */

/** What a tool job needs of the store. */
export type ToolJobStore = Pick<HarnessStore, 'getJobThread' | 'getEntry' | 'getThreadAgent' | 'completeToolJob' | 'failJob' | 'finishJob' | 'startSubAgent'> & ThreadTaskStore;

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

// Whether the call is a delegation the thread's agent may make, with the title and brief it gave.
function delegation(thread: ThreadRow, call: ToolCall): {title: string; brief: string} | null {
	if (call.name !== DELEGATE_TOOL || thread.parentThreadId !== null) {
		return null;
	}
	return delegateArgs(parseArgs(call));
}

function answer(store: ToolJobStore, thread: ThreadRow, job: JobRow, call: ToolCall, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const args = parseArgs(call);
		if (args === null) {
			return error('The arguments were not a JSON object.');
		}
		if (call.name === DELEGATE_TOOL && thread.parentThreadId === null) {
			return error('Give title, a few words, and brief, what to do.');
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

/** Runs the job: the call it is for, its answer written to the log, and the model woken once every call is answered; a delegation starts the sub-agent instead. */
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
		const delegated = delegation(thread, call);
		if (delegated) {
			if (!$(await store.startSubAgent(job.id, workerId, thread, subAgentStart(thread, {id: call.id, ...delegated})))) {
				return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
			}
			return;
		}
		const answered = $(await answer(store, thread, job, call, now));
		$(await store.completeToolJob(job.id, workerId, thread.id, {callId: call.id, ...answered}));
	});
}
