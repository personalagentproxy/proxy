import {cut, type ToolCall} from '@proxy/utils/harness';
import type {AfterAnswer, CallPlan, FailureNote, JobRow, SubAgentEnd, SubAgentStart, ThreadRow} from '@proxy/db/harness';
import type {NewAgentTask} from '@proxy/db/task';

/**
 * The rules of a conversation that the store's transactions write by (store.ts): how a delegation
 * becomes a sub-agent, its thread, its task and the first thing said in it; what ends a
 * sub-agent's work, and what the thread it was started from is told then; and what a failed job
 * leaves in its thread, so that nobody, the person or whoever delegated, is left waiting on it.
 */

// How much of a sub-agent's report its task keeps as the outcome, and of its brief as the goal.
const MAX_TASK_TEXT = 2000;

/** A task for a sub-agent's work, the member's, as the conversation it was delegated from is, run as the persona. */
export function taskFor(thread: ThreadRow, work: {title: string; goal: string}): NewAgentTask & {parentId: null} {
	return {
		orgId: thread.orgId,
		agentId: thread.agentId,
		ownerUserId: thread.userId,
		personaId: thread.personaId,
		parentId: null,
		title: work.title,
		goal: work.goal,
		via: 'harness',
	};
}

/** The sub-agent a delegate call starts: titled as the call says, its task the brief, and the brief the first thing said in its thread. */
export function subAgentStart(parent: ThreadRow, call: {id: string; title: string; brief: string}): SubAgentStart {
	return {
		callId: call.id,
		title: call.title,
		task: taskFor(parent, {title: call.title, goal: cut(call.brief, MAX_TASK_TEXT)}),
		entries: [{kind: 'person', text: call.brief}],
	};
}

/** A sub-agent's work ended with its report: the report is its task's outcome, and is what the thread it was started from is told, as is. */
export function subAgentEnd(report: {text: string; isError: boolean}): SubAgentEnd {
	return {outcome: cut(report.text, MAX_TASK_TEXT), report};
}

/** What follows the model's answer: a sub-agent's answer without calls is its report, which ends its work; any other, a job for each call. */
export function afterAnswer(thread: ThreadRow, turn: {text: string; toolCalls: ToolCall[]}, plans: Record<string, CallPlan>): AfterAnswer {
	if (turn.toolCalls.length === 0 && thread.parentThreadId !== null) {
		return {end: subAgentEnd({text: turn.text, isError: false})};
	}
	return {plans};
}

/**
 * What a job that failed with `error` leaves in its thread: a tool job's call is answered with the
 * failure, so the agent isn't left waiting for it (as an event where the call was answered as
 * started already, a delegation, as its report would have come); a sub-agent whose turn failed
 * reports the failure, so whoever delegated to it isn't; and a turn that failed in the member's
 * conversation is answered with the failure, so the person sees it and can go on.
 */
export function failureNote(error: string): (job: JobRow, thread: ThreadRow) => FailureNote | null {
	return (job, thread) => {
		if (job.kind === 'tool' && job.callId !== null) {
			return {kind: 'answer', callId: job.callId, text: `This call could not be run: ${error}`};
		}
		if (job.kind !== 'inference') {
			return null;
		}
		if (thread.parentThreadId !== null) {
			return {kind: 'end', end: subAgentEnd({text: `The sub-agent failed: ${error}`, isError: true})};
		}
		return {kind: 'reply', text: `Something went wrong on my side, so I could not answer: ${error.replace(/\.$/, '')}. Say something to try again.`};
	};
}
