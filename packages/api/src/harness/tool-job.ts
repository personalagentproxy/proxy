import {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {SLEEP_TOOL, sleepUntil} from '@proxy/utils/harness';
import {completeToolJob, failJob, finishJob, getEntry, getJobThread, type JobRow, type ThreadRow} from '@proxy/db/harness';

import {callMcpTool} from '../mcp/tools';
import {requireBuiltInAgent} from './built-in-agent';
import {ensureThreadTask} from './thread-task';
import {isGateTool} from './tool-surface';

/**
 * A tool job: one call the model made, run and answered in the log. The MCP server's tools go
 * through the gate as the built-in agent, for the thread's task, logged like any agent's call. A
 * sleep answers with the time, since its job was due when the sleep ended. A call that changes
 * something is never run twice: a worker that was interrupted mid-call leaves the outcome unknown,
 * and the model is told so rather than the call being made again.
 */

// How much of a result the log keeps, and the model reads.
const MAX_RESULT_CHARS = 60_000;

type ToolAnswer = {text: string; isError: boolean};

function error(text: string): ToolAnswer {
	return {text, isError: true};
}

function parseArgs(json: string): Record<string, unknown> | null {
	const parsed = Result.wrap((): unknown => JSON.parse(json));
	if (parsed.isErr() || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
		return null;
	}
	return parsed.value as Record<string, unknown>;
}

function cut(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Cut: the result was ${text.length} characters long.]`;
}

// Runs the call through the gate, for the thread's task.
function runGateTool(thread: ThreadRow, name: string, args: Record<string, unknown>, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const signedIn = $(await requireBuiltInAgent(thread.orgId));
		const taskId = $(await ensureThreadTask(thread, now));
		const result = await callMcpTool(signedIn, name, {...args, task: taskId}, false, 'harness');
		return {text: cut(result.content.map((part) => part.text).join('\n')), isError: result.isError === true};
	});
}

function answer(thread: ThreadRow, job: JobRow, call: {name: string; arguments: string}, now: Date): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const args = parseArgs(call.arguments);
		if (args === null) {
			return error('The arguments were not a JSON object.');
		}
		if (call.name === SLEEP_TOOL) {
			if (sleepUntil(args, now) === null) {
				return error('Give until, a time in ISO 8601, or seconds from now.');
			}
			return {text: `You slept, and it is now ${now.toISOString()}.`, isError: false};
		}
		if (!isGateTool(call.name)) {
			return error(`There is no tool ${call.name}.`);
		}
		// A write run by a worker that lost the job mid-call may have gone through.
		if (call.name === 'run' && job.attempts > 1) {
			return error('The outcome of this call is unknown: the worker running it was interrupted before it could record the answer. Check what it changed before making it again.');
		}
		return $(await runGateTool(thread, call.name, args, now));
	});
}

/** Runs the job: the call it is for, its answer written to the log, and the model woken once every call is answered. */
export function runToolJob(job: JobRow, workerId: string, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const thread = $(await getJobThread(job.threadId));
		if (!thread) {
			$(await finishJob(job.id, workerId));
			return;
		}
		const entry = $(await getEntry(job.entryId ?? ''));
		const call = entry.toolCalls?.find((candidate) => candidate.id === job.callId);
		if (!call) {
			$(await failJob(job.id, workerId, `No call ${job.callId ?? ''} in entry ${entry.id}`));
			return;
		}
		const answered = $(await answer(thread, job, call, now));
		$(await completeToolJob(job.id, workerId, thread.id, {callId: call.id, ...answered}));
	});
}
