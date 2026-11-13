import {
	callArguments,
	CREATE_SUBAGENT_TOOL,
	cut,
	parentMessageArgs,
	preview,
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
import {ApiErr, type ApiError} from '@proxy/utils';
import type {AfterAnswer, CallPlan, FailureNote, JobRow, SubAgentRow, SubAgentStart, SubAgentStop, ThreadEnd, ThreadOpening, ThreadRow} from '@proxy/db/harness';
import type {NewAgentTask} from '@proxy/db/task';

/**
 * The rules of a conversation that the store's transactions write by (store.ts): what is to
 * happen with each call the model made; how a call to start a sub-agent becomes one, its thread,
 * its task and the first thing said in it; what the agent and its sub-agents say to each other,
 * and what a sub-agent's stop is, its task's outcome and what the thread it was started from is
 * told; and what a failed job leaves in its thread, so that nobody, the person or the agent a
 * sub-agent works for, is left waiting on it. The words a call to start a sub-agent, to message
 * one or to message the agent a sub-agent works for is answered with are here too, since a
 * harness that runs its tools itself answers them inline (tool-surface.ts) with the same words.
 * A chat's thread, which the member's message opens, has rules of its own here: its title and its
 * task, cut from that message; its message to the person, which is the call itself, read where
 * the thread is shown; and its answer without calls, which ends its turn and tells nobody.
 */

/** What a write fenced by the job's lease that went nowhere means: the job was no longer the worker's, and the turn goes no further. */
export function jobLost(): ApiError {
	return ApiErr.conflict('The job was no longer this worker’s');
}

// How much of what a sub-agent said as it stopped its task keeps as the outcome, and of its brief
// as the goal.
const MAX_TASK_TEXT = 2000;

/** What a sub-agent's answer is followed by when it stops, so the agent it works for knows it did and how to go on. */
export const STOPPED_NOTE = '(It has stopped; a message takes it up again.)';

// How long a thread's title is: a line of the member's message that opened it.
const MAX_THREAD_TITLE = 80;

/**
 * A thread as the member's message in their chat opens it: titled with a line of what they said,
 * or, said with files alone, with the files' names; its task the same piece of work, the message
 * its goal, cut.
 */
export function threadOpening(chat: ThreadRow, said: {text: string; files: string[]}): ThreadOpening {
	const line = preview(said.text);
	const title = cut(line === '' ? preview(said.files.join(', ')) : line, MAX_THREAD_TITLE);
	return {title, task: taskFor(chat, {title, goal: said.text === '' ? title : cut(said.text, MAX_TASK_TEXT)})};
}

/** A chat thread's answer without calls, what it said: the end of its turn, and its task's outcome, cut. */
export function threadEnd(said: string): ThreadEnd {
	return {outcome: cut(said, MAX_TASK_TEXT)};
}

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

/** What a create_subagent call is answered with at once, the sub-agent's id in it, since every message to it takes the id. */
export function started(title: string): (id: string) => string {
	return (id) => `Started “${title}”, id ${id}.`;
}

export const SENT_TO_PARENT = 'Sent.';
export const SENT_TO_PERSON = 'Sent.';

/** What the calls that message or start an agent are answered with where their arguments are no good. */
export const BAD_SUBAGENT_ARGS = 'Give title, a few words, and brief, what to do.';
export const BAD_SUBAGENT_MESSAGE_ARGS = 'Give subagent, the sub-agent’s id, and text, the message.';
export const BAD_PARENT_MESSAGE_ARGS = 'Give text, the message.';
export const BAD_PERSON_MESSAGE_ARGS = 'Give text, the message.';

/** What a send_to_subagent call is answered with at once: what the sub-agent was up to as the message came, or that there is no such sub-agent of the agent's. */
export function sentToSubAgent(id: string): (subAgent: SubAgentRow | null) => {text: string; isError: boolean} {
	return (subAgent) => {
		if (!subAgent) {
			return {text: `No sub-agent ${id}.`, isError: true};
		}
		const was =
			subAgent.state.kind === 'stopped'
				? 'had stopped, and takes it up'
				: subAgent.state.kind === 'asleep'
					? 'was asleep, and is woken by it'
					: 'is at work, and reads it when its current call is answered';
		return {text: `Sent to “${subAgent.title ?? ''}”, which ${was}.`, isError: false};
	};
}

/**
 * What is to happen with one call: a sleep's job, a sub-agent's or a thread's, is due when it
 * ends; the main agent's call to start a sub-agent starts it as the answer is written, and its
 * message to one, and a sub-agent's message to it, are sent then; a thread's message to the
 * person is answered at once, the call being what the person reads; each is answered at once
 * where its arguments are no good; every other call's job is due now.
 */
export function planCall(thread: ThreadRow, call: ToolCall, now: Date): CallPlan {
	const args = callArguments(call);
	const role = threadRole(thread);
	if (call.name === SLEEP_TOOL && role !== 'chat') {
		return {kind: 'job', runAt: sleepUntil(args, now) ?? now};
	}
	if (call.name === CREATE_SUBAGENT_TOOL && role === 'chat') {
		const parsed = subAgentArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: BAD_SUBAGENT_ARGS, isError: true};
		}
		return {kind: 'create_subagent', start: subAgentStart(thread, {id: call.id, ...parsed}), started: started(parsed.title)};
	}
	if (call.name === SEND_TO_SUBAGENT_TOOL && role === 'chat') {
		const parsed = subAgentMessageArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: BAD_SUBAGENT_MESSAGE_ARGS, isError: true};
		}
		return {kind: 'send_to_subagent', subAgentId: parsed.subagent, entry: {kind: 'person', text: parsed.text}, sent: sentToSubAgent(parsed.subagent)};
	}
	if (call.name === SEND_TO_PARENT_TOOL && role === 'subagent') {
		const parsed = parentMessageArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: BAD_PARENT_MESSAGE_ARGS, isError: true};
		}
		return {kind: 'send_to_parent', message: {text: parsed.text, isError: false}, sent: SENT_TO_PARENT};
	}
	if (call.name === SEND_TO_PERSON_TOOL && role === 'thread') {
		return parentMessageArgs(args) ? {kind: 'answer', text: SENT_TO_PERSON, isError: false} : {kind: 'answer', text: BAD_PERSON_MESSAGE_ARGS, isError: true};
	}
	return {kind: 'job', runAt: now};
}

/** What is to happen with each of the model's calls, by the id it gave the call. */
export function planCalls(thread: ThreadRow, calls: ToolCall[], now: Date): Record<string, CallPlan> {
	return Object.fromEntries(calls.map((call) => [call.id, planCall(thread, call, now)]));
}

/**
 * What follows the model's answer: a sub-agent's answer without calls stops it, with that said; a
 * chat thread's ends its turn; any other, its calls as planned.
 */
export function afterAnswer(thread: ThreadRow, turn: {text: string; toolCalls: ToolCall[]}, plans: Record<string, CallPlan>): AfterAnswer {
	const role = threadRole(thread);
	if (turn.toolCalls.length === 0 && role === 'subagent') {
		return {stop: subAgentStop({text: turn.text, isError: false})};
	}
	if (turn.toolCalls.length === 0 && role === 'thread') {
		return {end: threadEnd(turn.text)};
	}
	return {plans};
}

/**
 * What a job that failed with `error` leaves in its thread: a tool job's call is answered with the
 * failure, so the agent isn't left waiting for it; a sub-agent whose turn failed, a wake-up's
 * too, stops with the failure, so the agent it works for isn't; and a turn that failed in the
 * member's conversation, or in one of their chat's threads, is answered with the failure, so the
 * person sees it and can go on, the thread's turn ending with it.
 */
export function failureNote(error: string): (job: JobRow, thread: ThreadRow) => FailureNote | null {
	return (job, thread) => {
		if (job.kind === 'tool') {
			return job.callId === null ? null : {kind: 'answer', callId: job.callId, text: `This call could not be run: ${error}`};
		}
		const role = threadRole(thread);
		if (role === 'subagent') {
			return {kind: 'stop', stop: subAgentStop({text: `The sub-agent failed: ${error}`, isError: true})};
		}
		const text = `Something went wrong on my side, so I could not answer: ${error.replace(/\.$/, '')}. Say something to try again.`;
		if (role === 'thread') {
			return {kind: 'end', text, end: threadEnd(text)};
		}
		return {kind: 'reply', text};
	};
}
