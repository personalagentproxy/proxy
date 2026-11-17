import {
	ATTACHMENT_MARK,
	callArguments,
	CREATE_SUBAGENT_TOOL,
	cut,
	parentMessageArgs,
	personMessageArgs,
	preview,
	SEND_TO_PARENT_TOOL,
	SEND_TO_PERSON_TOOL,
	SEND_TO_SUBAGENT_TOOL,
	SLEEP_TOOL,
	sleepUntil,
	subAgentArgs,
	subAgentMessageArgs,
	type ToolCall,
} from '@proxy/utils/harness';
import {ApiErr, type ApiError} from '@proxy/utils';
import type {AfterAnswer, CallPlan, FailureNote, JobRow, SubAgentRow, SubAgentStart, ThreadEnd, ThreadOpening, ThreadRow} from '@proxy/db/harness';
import type {NewAgentTask} from '@proxy/db/task';

/**
 * The rules of a chat's threads that the store's transactions write by (store.ts): how the
 * member's message opens a thread, its title and its task cut from what they said; what is to
 * happen with each call the model made; what its answer without calls is, the end of its turn and
 * its task's outcome, which tells nobody, the member reading it in the thread; and what a failed
 * job leaves in the thread, so the member is not left waiting on it. The words a message to the
 * person is answered with are here too, since a harness that runs its tools itself answers it
 * inline (tool-surface.ts) with the same words: the call is what the member reads, where the
 * thread is shown.
 */

/** What a write fenced by the job's lease that went nowhere means: the job was no longer the worker's, and the turn goes no further. */
export function jobLost(): ApiError {
	return ApiErr.conflict('The job was no longer this worker’s');
}

// How much of the member's message a thread's task keeps as its goal, and of what the thread said
// as its turn ended as the outcome.
const MAX_TASK_TEXT = 2000;

// How long a thread's title is: a line of the member's message that opened it.
const MAX_THREAD_TITLE = 80;

// Text with its whitespace folded, as a line.
function folded(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// A line to call a thread by, of what the member said in words: as a list shows a message, its
// Markdown dropped; said with files alone, the files' names; said in a block of code alone, as a
// pasted log is, or in marks alone, which a list's line drops, the code without its fences, or the
// marks as they are. Never empty, the member having said something or attached a file.
function titleOf(words: string, files: string[]): string {
	const names = files.join(', ');
	const lines = [preview(words), preview(names), folded(words.replace(/```(?:[\w+-]*\n)?/g, ' ')), folded(words), names];
	return lines.find((line) => line !== '') ?? '';
}

// What the member said with each file's name in brackets where they put it among their words, as
// the model reads it (utils/harness-context withAttachments), in place of the mark that stands
// for it.
function withFileNames(text: string, files: string[]): string {
	let placed = 0;
	return text
		.replaceAll(ATTACHMENT_MARK, () => {
			const name = files[placed];
			placed += 1;
			return name === undefined ? '' : `[${name}]`;
		})
		.trim();
}

/**
 * A thread as the member's message in their chat opens it: titled with a line of what they said,
 * or, said with files alone, with the files' names; its task the same piece of work, the message
 * its goal, each file named where it sits among the words, cut.
 */
export function threadOpening(chat: ThreadRow, said: {text: string; files: string[]}): ThreadOpening {
	const words = said.text.replaceAll(ATTACHMENT_MARK, ' ').trim();
	const title = cut(titleOf(words, said.files), MAX_THREAD_TITLE);
	return {title, task: taskFor(chat, {title, goal: words === '' ? title : cut(withFileNames(said.text, said.files), MAX_TASK_TEXT)})};
}

/**
 * A thread as an alert that opens new threads opens one in the chat: titled `title`, cut, the
 * alert's or the record's that came; its task the alert's work, its brief the goal.
 */
export function alertOpening(chat: ThreadRow, alert: {title: string; brief: string}): ThreadOpening {
	const title = cut(folded(alert.title), MAX_THREAD_TITLE);
	return {title, task: taskFor(chat, {title, goal: cut(alert.brief, MAX_TASK_TEXT)})};
}

/** What a sub-agent's answer is followed by when it stops, so the thread's agent knows it did and how to go on. */
export const STOPPED_NOTE = '(It has stopped; a message takes it up again.)';

/**
 * A thread's answer without calls, what it said: the end of its turn, and its task's outcome, cut;
 * and, where the thread is a sub-agent's, what the thread it works for is told: what it said, with
 * the note that it stopped, or, where a message came meanwhile, which it goes on to read, alone.
 */
export function threadEnd(said: string, isError = false): ThreadEnd {
	return {
		outcome: cut(said, MAX_TASK_TEXT),
		toParent: {stopped: {text: `${said}\n\n${STOPPED_NOTE}`, isError}, goingOn: {text: said, isError}},
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

/** What a create_subagent call is answered with at once, the sub-agent's id in it, since every message to it takes the id. */
export function started(title: string): (id: string) => string {
	return (id) => `Started “${title}”, id ${id}. What it says comes to you as a message.`;
}

export const SENT_TO_PARENT = 'Sent.';

/** What the three calls are answered with where their arguments are no good. */
export const BAD_SUBAGENT_ARGS = 'Give title, a few words, and brief, what to do.';
export const BAD_SUBAGENT_MESSAGE_ARGS = 'Give subagent, the sub-agent’s id, and text, the message.';
export const BAD_PARENT_MESSAGE_ARGS = 'Give text, the message.';

/** What a send_to_subagent call is answered with at once: what the sub-agent was up to as the message came, or that the thread has no such sub-agent. */
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

/** Whether the thread is a sub-agent's, which works for another thread's agent rather than the person. */
export function isSubAgent(thread: ThreadRow): boolean {
	return thread.subAgentOfId !== null;
}

// The calls a sub-agent has (tool-surface.ts SUB_AGENT_TOOLS): the MCP server's script, a message to
// the thread it works for, and a sleep.
const SUB_AGENT_CALLS = ['script', SEND_TO_PARENT_TOOL, SLEEP_TOOL];

/** Whether the thread hasn't got the tool, which its call is answered there is no such tool for: a sub-agent has its own few, and only a sub-agent has a message to the thread it works for. */
export function notTheThreads(thread: ThreadRow, name: string): boolean {
	if (isSubAgent(thread)) {
		return !SUB_AGENT_CALLS.includes(name);
	}
	return name === SEND_TO_PARENT_TOOL;
}

/** A task for a thread's work, the member's, as the chat it is of is, run as the persona. */
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

/** The calls a thread shows, as what the persona told the person as it went: its messages to them. */
export const SHOWN_CALLS = [SEND_TO_PERSON_TOOL];

export const SENT_TO_PERSON = 'Sent.';

/** What a message to the person is answered with where its arguments are no good. */
export const BAD_PERSON_MESSAGE_ARGS = 'Give text, the message.';

/**
 * What is to happen with one call: a sleep's job is due when it ends; a message to the person is
 * answered at once, the call being what the person reads, or where its arguments are no good; a
 * thread's call to start a sub-agent starts it as the answer is written, and its message to one,
 * and a sub-agent's message to the thread it works for, are sent then, each answered at once,
 * where its arguments are no good too; every other call's job is due now, the tool job answering
 * one the thread hasn't got (tool-job.ts).
 */
export function planCall(thread: ThreadRow, call: ToolCall, now: Date): CallPlan {
	const args = callArguments(call);
	if (call.name === SLEEP_TOOL) {
		return {kind: 'job', runAt: sleepUntil(args, now) ?? now};
	}
	if (call.name === SEND_TO_PERSON_TOOL && !isSubAgent(thread)) {
		return personMessageArgs(args) ? {kind: 'answer', text: SENT_TO_PERSON, isError: false} : {kind: 'answer', text: BAD_PERSON_MESSAGE_ARGS, isError: true};
	}
	if (call.name === CREATE_SUBAGENT_TOOL && !isSubAgent(thread)) {
		const parsed = subAgentArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: BAD_SUBAGENT_ARGS, isError: true};
		}
		return {kind: 'create_subagent', start: subAgentStart(thread, {id: call.id, ...parsed}), started: started(parsed.title)};
	}
	if (call.name === SEND_TO_SUBAGENT_TOOL && !isSubAgent(thread)) {
		const parsed = subAgentMessageArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: BAD_SUBAGENT_MESSAGE_ARGS, isError: true};
		}
		return {kind: 'send_to_subagent', subAgentId: parsed.subagent, entry: {kind: 'person', text: parsed.text}, sent: sentToSubAgent(parsed.subagent)};
	}
	if (call.name === SEND_TO_PARENT_TOOL && isSubAgent(thread)) {
		const parsed = parentMessageArgs(args);
		if (!parsed) {
			return {kind: 'answer', text: BAD_PARENT_MESSAGE_ARGS, isError: true};
		}
		return {kind: 'send_to_parent', message: {text: parsed.text, isError: false}, sent: SENT_TO_PARENT};
	}
	return {kind: 'job', runAt: now};
}

/** What is to happen with each of the model's calls, by the id it gave the call. */
export function planCalls(thread: ThreadRow, calls: ToolCall[], now: Date): Record<string, CallPlan> {
	return Object.fromEntries(calls.map((call) => [call.id, planCall(thread, call, now)]));
}

/** What follows the model's answer: an answer without calls ends the thread's turn; any other, its calls as planned. */
export function afterAnswer(turn: {text: string; toolCalls: ToolCall[]}, plans: Record<string, CallPlan>): AfterAnswer {
	if (turn.toolCalls.length === 0) {
		return {end: threadEnd(turn.text)};
	}
	return {plans};
}

/**
 * What a job that failed with `error` leaves in its thread: a tool job's call is answered with the
 * failure, so the agent isn't left waiting for it; and a turn that failed, a wake-up's too, is
 * answered with the failure, so the member sees it and can go on, the thread's turn ending with it.
 */
export function failureNote(error: string): (job: JobRow) => FailureNote | null {
	return (job) => {
		if (job.kind === 'tool') {
			return job.callId === null ? null : {kind: 'answer', callId: job.callId, text: `This call could not be run: ${error}`};
		}
		const text = `Something went wrong on my side, so I could not answer: ${error.replace(/\.$/, '')}. Say something to try again.`;
		return {kind: 'end', text, end: threadEnd(text, true)};
	};
}
