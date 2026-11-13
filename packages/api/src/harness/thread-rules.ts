import {ATTACHMENT_MARK, callArguments, cut, personMessageArgs, preview, SEND_TO_PERSON_TOOL, SLEEP_TOOL, sleepUntil, type ToolCall} from '@proxy/utils/harness';
import {ApiErr, type ApiError} from '@proxy/utils';
import type {AfterAnswer, CallPlan, FailureNote, JobRow, ThreadEnd, ThreadOpening, ThreadRow} from '@proxy/db/harness';
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

/** A thread's answer without calls, what it said: the end of its turn, and its task's outcome, cut. */
export function threadEnd(said: string): ThreadEnd {
	return {outcome: cut(said, MAX_TASK_TEXT)};
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
 * answered at once, the call being what the person reads, or where its arguments are no good;
 * every other call's job is due now.
 */
export function planCall(call: ToolCall, now: Date): CallPlan {
	const args = callArguments(call);
	if (call.name === SLEEP_TOOL) {
		return {kind: 'job', runAt: sleepUntil(args, now) ?? now};
	}
	if (call.name === SEND_TO_PERSON_TOOL) {
		return personMessageArgs(args) ? {kind: 'answer', text: SENT_TO_PERSON, isError: false} : {kind: 'answer', text: BAD_PERSON_MESSAGE_ARGS, isError: true};
	}
	return {kind: 'job', runAt: now};
}

/** What is to happen with each of the model's calls, by the id it gave the call. */
export function planCalls(calls: ToolCall[], now: Date): Record<string, CallPlan> {
	return Object.fromEntries(calls.map((call) => [call.id, planCall(call, now)]));
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
		return {kind: 'end', text, end: threadEnd(text)};
	};
}
