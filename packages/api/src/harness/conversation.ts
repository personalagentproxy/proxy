import {
	callArguments,
	CREATE_SUBAGENT_TOOL,
	cut,
	parentMessageArgs,
	SEND_TO_PARENT_TOOL,
	SEND_TO_SUBAGENT_TOOL,
	SLEEP_TOOL,
	sleepUntil,
	subAgentArgs,
	subAgentMessageArgs,
	type ToolCall,
} from '@proxy/utils/harness';
import type {AfterAnswer, CallPlan, FailureNote, JobRow, SubAgentRow, SubAgentStart, SubAgentStop, ThreadRow} from '@proxy/db/harness';
import type {NewAgentTask} from '@proxy/db/task';

/**
 * The rules of a conversation that the store's transactions write by (store.ts): what is to
 * happen with each call the model made; how a call to start a sub-agent becomes one, its thread,
 * its task and the first thing said in it; what the agent and its sub-agents say to each other,
 * and what a sub-agent's stop is, its task's outcome and what the thread it was started from is
 * told; and what a failed job leaves in its thread, so that nobody, the person or the agent a
 * sub-agent works for, is left waiting on it.
 */

// How much of what a sub-agent said as it stopped its task keeps as the outcome, and of its brief
// as the goal.
const MAX_TASK_TEXT = 2000;

/** What a sub-agent's answer is followed by when it stops, so the agent it works for knows it did and how to go on. */
export const STOPPED_NOTE = '(The sub-agent has stopped for now. It keeps what it did and found: a message to it takes it up again.)';

/** A task for a sub-agent's work, the member's, as the conversation it was started from is, run as the persona. */
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

/** The sub-agent a create_subagent call starts: titled as the call says, its task the brief, and the brief the first thing said in its thread. */
export function subAgentStart(parent: ThreadRow, call: {id: string; title: string; brief: string}): SubAgentStart {
	return {
		callId: call.id,
		title: call.title,
		task: taskFor(parent, {title: call.title, goal: cut(call.brief, MAX_TASK_TEXT)}),
		entries: [{kind: 'person', text: call.brief}],
	};
}

/**
 * A sub-agent's answer without calls, what it said: where it stops, that is its task's outcome,
 * cut, and what the thread it was started from is told, with the note that it stopped; where a
 * message came meanwhile, which it goes on to read, it is told what was said alone.
 */
export function subAgentStop(said: {text: string; isError: boolean}): SubAgentStop {
	return {outcome: cut(said.text, MAX_TASK_TEXT), stopped: {...said, text: `${said.text}\n\n${STOPPED_NOTE}`}, goingOn: said};
}

// What a create_subagent call is answered with at once, the sub-agent's id in it, since every message
// to it takes the id.
function started(title: string): (id: string) => string {
	return (id) => `Started the sub-agent “${title}”, id ${id}. What it says will come to you as a message.`;
}

const SENT_TO_PARENT = 'Sent to the agent you work for. Its answer, if any, will come to you as a message.';

// What a send_to_subagent call is answered with at once: what the sub-agent was up to as the
// message came, or that there is no such sub-agent of the agent's.
function sentToSubAgent(id: string): (subAgent: SubAgentRow | null) => {text: string; isError: boolean} {
	return (subAgent) => {
		if (!subAgent) {
			return {text: `You have no sub-agent with id ${id}. Your sub-agents and their ids are listed in your instructions.`, isError: true};
		}
		const was =
			subAgent.state.kind === 'stopped'
				? 'had stopped, and takes it up'
				: subAgent.state.kind === 'asleep'
					? 'was asleep, and is woken by it'
					: 'is at work, and reads it when its current call is answered';
		return {text: `Sent to the sub-agent “${subAgent.title ?? ''}”, which ${was}. What it says back will come to you as a message.`, isError: false};
	};
}

/**
 * What is to happen with one call: a sub-agent's sleep's job is due when it ends; the main
 * agent's call to start a sub-agent starts it as the answer is written, and its message to one,
 * and a sub-agent's message to it, are sent then, each answered at once where its arguments are no
 * good; every other call's job is due now.
 */
export function planCall(thread: ThreadRow, call: ToolCall, now: Date): CallPlan {
	const args = callArguments(call);
	if (call.name === SLEEP_TOOL && thread.parentThreadId !== null) {
		return {kind: 'job', runAt: sleepUntil(args, now) ?? now};
	}
	if (call.name === CREATE_SUBAGENT_TOOL && thread.parentThreadId === null) {
		const parsed = subAgentArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: 'Give title, a few words, and brief, what to do.', isError: true};
		}
		return {kind: 'create_subagent', start: subAgentStart(thread, {id: call.id, ...parsed}), started: started(parsed.title)};
	}
	if (call.name === SEND_TO_SUBAGENT_TOOL && thread.parentThreadId === null) {
		const parsed = subAgentMessageArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: 'Give subagent, the sub-agent’s id, and text, the message.', isError: true};
		}
		return {kind: 'send_to_subagent', subAgentId: parsed.subagent, entry: {kind: 'person', text: parsed.text}, sent: sentToSubAgent(parsed.subagent)};
	}
	if (call.name === SEND_TO_PARENT_TOOL && thread.parentThreadId !== null) {
		const parsed = parentMessageArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: 'Give text, the message.', isError: true};
		}
		return {kind: 'send_to_parent', message: {text: parsed.text, isError: false}, sent: SENT_TO_PARENT};
	}
	return {kind: 'job', runAt: now};
}

/** What is to happen with each of the model's calls, by the id it gave the call. */
export function planCalls(thread: ThreadRow, calls: ToolCall[], now: Date): Record<string, CallPlan> {
	return Object.fromEntries(calls.map((call) => [call.id, planCall(thread, call, now)]));
}

/** What follows the model's answer: a sub-agent's answer without calls stops it, with that said; any other, its calls as planned. */
export function afterAnswer(thread: ThreadRow, turn: {text: string; toolCalls: ToolCall[]}, plans: Record<string, CallPlan>): AfterAnswer {
	if (turn.toolCalls.length === 0 && thread.parentThreadId !== null) {
		return {stop: subAgentStop({text: turn.text, isError: false})};
	}
	return {plans};
}

/**
 * What a job that failed with `error` leaves in its thread: a tool job's call is answered with the
 * failure, so the agent isn't left waiting for it; a sub-agent whose turn failed, a wake-up's
 * too, stops with the failure, so the agent it works for isn't; and a turn that failed in the
 * member's conversation is answered with the failure, so the person sees it and can go on.
 */
export function failureNote(error: string): (job: JobRow, thread: ThreadRow) => FailureNote | null {
	return (job, thread) => {
		if (job.kind === 'tool') {
			return job.callId === null ? null : {kind: 'answer', callId: job.callId, text: `This call could not be run: ${error}`};
		}
		if (thread.parentThreadId !== null) {
			return {kind: 'stop', stop: subAgentStop({text: `The sub-agent failed: ${error}`, isError: true})};
		}
		return {kind: 'reply', text: `Something went wrong on my side, so I could not answer: ${error.replace(/\.$/, '')}. Say something to try again.`};
	};
}
