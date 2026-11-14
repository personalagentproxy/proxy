import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {callArguments, isRecord, OUTCOME_UNKNOWN, SLEEP_TOOL, sleepUntil, START_THREAD_TOOL, type ToolCall} from '@proxy/utils/harness';
import type {JobRow, ThreadRow} from '@proxy/db/harness';

import {CANCEL_ALERT_TOOL, SET_ALERT_TOOL} from './alerts';
import {type StartThreadStore, startThreadCall} from './start-thread';
import {failureNote} from './thread-rules';
import type {HarnessStore} from './store';
import {type AlertCallOutcome, alertCall, BAD_SLEEP_ARGS, error, NOT_JSON, noSuchTool, runGateTool, setText, type ToolAnswerStore} from './tool-answers';
import {isGateTool} from './tool-surface';

/**
 * A tool job: one call the model made, run and answered in the log, which is how a harness that
 * leaves its calls open has them run (inference.ts). A thread's alert calls set an alert, at a
 * time or a watch on the connections it may read with the collection (alerts.ts), or cancel one;
 * its message to the person is answered as the answer is written (thread-rules.ts planCall); a
 * thread it starts is opened in the person's chat (start-thread.ts), at most once. Its
 * scripts make their calls through the gate as the thread's agent acting as the member, for the
 * thread's task, logged like any agent's call. A sleep answers with the time, since its job was
 * due when the sleep ended, or when a reply woke it, which follows the answer. A script, which may change something, is never run twice: a worker
 * that was interrupted mid-script leaves the outcome unknown, and the model is told so rather than
 * the script being run again; a call that sets an alert sets it in the transaction that answers
 * it, so a job run again after it was answered sets nothing more. What each tool answers is shared
 * with the harnesses that run their calls themselves (tool-answers.ts).
 */

/** What a tool job needs of the store. */
export type ToolJobStore = Pick<HarnessStore, 'getJobThread' | 'getEntry' | 'completeToolJob' | 'completeSetAlert' | 'failJob' | 'finishJob'> & ToolAnswerStore & StartThreadStore;

function answer(store: ToolJobStore, thread: ThreadRow, job: JobRow, call: ToolCall, now: Date): Promise<Result<AlertCallOutcome, ApiError>> {
	return Do(async ($) => {
		const args = callArguments(call);
		if (!isRecord(args)) {
			return error(NOT_JSON);
		}
		if (call.name === SET_ALERT_TOOL || call.name === CANCEL_ALERT_TOOL) {
			return $(await alertCall(store, thread, call, args, now));
		}
		if (call.name === SLEEP_TOOL) {
			if (sleepUntil(args, now) === null) {
				return error(BAD_SLEEP_ARGS);
			}
			return {text: `Woken at ${now.toISOString()}.`, isError: false};
		}
		if (call.name === START_THREAD_TOOL) {
			// A worker that lost the job mid-call may have started the thread already.
			if (job.attempts > 1) {
				return error(OUTCOME_UNKNOWN);
			}
			return $(await startThreadCall(store, thread, args));
		}
		if (!isGateTool(call.name)) {
			return noSuchTool(call.name);
		}
		// A script run by a worker that lost the job mid-call may have changed something.
		if (job.attempts > 1) {
			return error(OUTCOME_UNKNOWN);
		}
		return $(await runGateTool(store, thread, args));
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
			const why = `No call ${job.callId ?? ''} in entry ${entry.id}`;
			$(await store.failJob(job.id, workerId, why, failureNote(why)));
			return;
		}
		const outcome = $(await answer(store, thread, job, call, now));
		if ('alert' in outcome) {
			$(await store.completeSetAlert({jobId: job.id, workerId, threadId: thread.id, callId: call.id}, outcome.alert, setText));
			return;
		}
		$(await store.completeToolJob(job.id, workerId, thread.id, {callId: call.id, ...outcome}));
	});
}
