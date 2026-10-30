import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {callArguments, DELEGATE_TOOL, delegateArgs, SLEEP_TOOL, sleepUntil, type ToolCall} from '@proxy/utils/harness';
import {
	appendSummary,
	type AssistantTurn,
	type CallPlan,
	completeInference,
	type EntryRow,
	finishJob,
	getJobThread,
	getThreadAgent,
	type JobRow,
	listEntries,
	requeueJob,
	type ThreadRow,
} from '@proxy/db/harness';

import {askForTurn, type ModelTurn} from '../llm/open-router';
import {agentInstructions} from '../mcp/tools';
import {log, serializeError} from '../observability/log';
import {env} from '../utils/env';
import {compactionCut, toMessages, toTranscript} from './context';
import {toolsFor} from './tool-surface';

/**
 * An inference job: the model, run once on a thread's log, which is ready for it, every call
 * answered, and changes under it only by what the job itself writes (db/harness). Its answer goes
 * in the log as an assistant entry, with a tool job for each call it made; a sleep's job is due
 * when the sleep ends, and a delegation is answered at once as started, its report to come as an
 * event. A log that has grown long is first summarized, in a summary entry the model reads in
 * place of what it covers. A model that can't be reached is tried again a few times, then the
 * person is told; any other failure fails the job, which tells them too (db/harness failJob). A
 * sub-agent's answer with no calls is its report, and ends its work. An answer of nothing, no
 * words and no calls, is written as that said: the person would otherwise see nothing, and the
 * model refuses a log with an empty turn in it. The answer is written with the system prompt the
 * model was sent, which is built from the login's grants as they are then, so that what the model
 * read can be told later; the rest of the request is rebuilt from the log.
 */

// How the agent talking with the person is to go about it: it does nothing itself, and hands
// every piece of work to a sub-agent.
const MAIN_FLOW =
	'You are talking with the person directly, on the Chat page of Personal Agent Proxy; what you write is shown to them as a chat message, rendered as Markdown, so write short, and answer what they asked: plain sentences for most things, a list or a table where it lays out better, no headings. You make no calls to their accounts yourself: you have one tool, delegate, which starts a sub-agent on a piece of work with the same access as you. Where these instructions name a tool such as read, run, entries_list or entries_create, that is what a sub-agent does on your behalf: put it in its brief. The sub-agent knows nothing but its brief and can’t ask anything, so put in it everything it needs, including what to report back. delegate answers at once that the sub-agent has started; its report comes to you as a message when it is done. Until then, go on, or, when there is nothing to do but wait, tell the person in a few words what you are looking into, such as “Looking through your inboxes and notes for the Lisbon trip.”, and stop. Never tell the person how you work: say nothing of sub-agents, briefs, reports or searches you started or are waiting on; to them, you are doing the work yourself. Hand one question to one sub-agent, even when the answer spans several accounts: it can look in them all. Start several only for separate pieces of work, each a sizeable job of its own. When a report comes, tell the person what matters of it, or start the next piece; while other sub-agents you started are still working, say nothing of a report unless it changes what the person should know now, and answer once you have the whole picture. A long conversation is summarized for you as it goes, and older reports are cleared from it: take a summary as what happened, and don’t mention that the conversation was summarized.';

// How a sub-agent is to go about it: one brief, its tools, and a report at the end.
const SUB_FLOW =
	'You are a sub-agent of the agent talking with the person on the Chat page of Personal Agent Proxy. The first message is your brief from it; nothing you write is read until you are done, and nobody answers questions, so ask none: do what the brief says with what you have, and where you can’t, say so in your report. list_connections lists the accounts you can use and what you may do with each. list_tools with a connection gives that connection’s tools and the params each takes. Don’t guess a tool’s params: where these instructions don’t give them, call list_tools for the connection before you first read or run one of its tools. read runs the tools that only read; run runs the ones that change something or reach other people. Every call is made for your task, filled in for you: there is nothing to start or finish. When you have called sleep_until, you are woken at that time with nothing but this log, so say in your message what you will do then. Your first message without a tool call is your report, handed back as it is, and ends your work: say what you did and found, with the names, ids, dates and numbers that matter, and what you could not do; nothing else. A long log is summarized for you as it goes: take a summary as what happened.';

// How a long log is summarized, by the same model, for itself: a conversation's, or a
// sub-agent's, whose one message from the person is its brief.
const SUMMARIZE =
	'You are summarizing a conversation between a person and their agent, written out below with the calls the agent made and what they answered, so that the agent can go on from the summary in place of the conversation so far. Write what the agent needs to go on as if it remembered: what the person asked for and what they said they want in general; what was done and found, with the names, ids, dates and numbers that matter; what the person was told; what is still open, promised or planned, such as what to do after a sleep or when a sub-agent reports. Leave out what no longer matters. Plain prose, from the agent’s side, no title.';
const SUMMARIZE_NOW = 'Write the summary now.';

// How many answers the model may give in a row without the person saying anything, calls,
// reports and wake-ups included, before it stops and waits for them; a report that comes after
// the stop is acted on, and the count starts over.
const MAX_TURNS_ALONE = 30;

// How often a model that can't be reached is tried, and how long to wait between tries.
const MAX_MODEL_ATTEMPTS = 3;
const RETRY_MS = 5_000;

const MAX_TOKENS = 4000;
const TIMEOUT_MS = 120_000;

const NOT_SET_UP = 'Chat is not set up on this server: it needs an OpenRouter key (OPENROUTER_KEY). Everything else works as before.';
const UNREACHABLE = 'The model could not be reached. Say something to try again.';
const TOO_LONG = `I have taken ${MAX_TURNS_ALONE} steps without hearing from you, so I have stopped. Tell me to go on if you want me to.`;
const TOO_LONG_SUB = `I took ${MAX_TURNS_ALONE} steps without finishing, so I stopped. This is not a complete report.`;
const NOTHING = 'I had nothing to say to that. Say something to go on.';
const NOTHING_SUB = 'I finished without a report.';

// Whether the answer is the model stopping for the person, at the cap: the count starts over
// from it, so a report that comes after the stop is acted on rather than answered with the stop
// again, once per report.
function isStop(entry: EntryRow): boolean {
	return entry.kind === 'assistant' && (entry.text === TOO_LONG || entry.text === TOO_LONG_SUB);
}

// How many answers the model has given since the person last spoke, or since it last stopped for
// them.
function turnsAlone(entries: EntryRow[]): number {
	const since = entries.findLastIndex((entry) => entry.kind === 'person' || isStop(entry));
	return entries.slice(since + 1).filter((entry) => entry.kind === 'assistant').length;
}

// What a delegation is answered with at once, the report to come as an event.
function started(title: string): string {
	return `Started the sub-agent “${title}”. Its report will come to you as a message when it is done.`;
}

// What is to happen with each call: a sleep's job is due when it ends, a delegation is answered
// as started, every other call's job is due now.
function plans(thread: ThreadRow, calls: ToolCall[], now: Date): Record<string, CallPlan> {
	return Object.fromEntries(
		calls.map((call) => {
			const args = callArguments(call);
			if (call.name === SLEEP_TOOL && thread.parentThreadId !== null) {
				return [call.id, {runAt: sleepUntil(args, now) ?? now, placeholder: null}];
			}
			const delegated = call.name === DELEGATE_TOOL && thread.parentThreadId === null ? delegateArgs(args) : null;
			return [call.id, {runAt: now, placeholder: delegated ? started(delegated.title) : null}];
		}),
	);
}

// The answer as it goes in the log: an answer of nothing says so.
function said(thread: ThreadRow, turn: ModelTurn): ModelTurn {
	if (turn.text.trim() !== '' || turn.toolCalls.length > 0) {
		return turn;
	}
	return {...turn, text: thread.parentThreadId === null ? NOTHING : NOTHING_SUB};
}

// Writes the answer back; a job no longer the worker's is a conflict.
function writeBack(job: JobRow, workerId: string, turn: AssistantTurn, callPlans: Record<string, CallPlan>): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (!$(await completeInference(job.id, workerId, job.threadId, turn, callPlans))) {
			return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
		}
	});
}

// Answers the person with `text` alone, as the model would, when the model can't be run: no
// prompt was built.
function answerWith(job: JobRow, workerId: string, text: string): Promise<Result<void, ApiError>> {
	return writeBack(job, workerId, {text, toolCalls: [], inputTokens: 0, outputTokens: 0, system: null}, {});
}

// Why the model couldn't be reached, for the job's record.
function unreachable(failure: ApiError): string {
	const cause = 'cause' in failure ? failure.cause : null;
	return `The model could not be reached${cause instanceof Error ? `: ${cause.message}` : ''}`;
}

// The system prompt: the instructions any agent with the login gets, for the agent as it acts in
// the thread, as the member whose conversation it is, and how to go about it on this thread.
function systemPrompt(thread: ThreadRow, now: Date): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const signedIn = $(requirePresent($(await getThreadAgent(thread)), ApiErr.notFound('agent', thread.agentId)));
		const instructions = $(await agentInstructions(signedIn, thread.parentThreadId === null ? MAIN_FLOW : SUB_FLOW));
		return `${instructions}\n\nThe time now is ${now.toISOString()}.`;
	});
}

// Summarizes the log where it has grown long, into a summary entry the model reads in place of
// what it covers; the log then, as it is. The model gets the log as text, not as the turns it
// made, which would need the tools sent along: a request with calls in it and no tools is refused.
function compact(job: JobRow, workerId: string, entries: EntryRow[], key: string): Promise<Result<EntryRow[], ApiError>> {
	return Do(async ($) => {
		const cut = compactionCut(entries);
		const last = cut === null ? undefined : entries[cut - 1];
		if (cut === null || !last) {
			return entries;
		}
		const summary = $(
			await askForTurn({
				key,
				messages: [
					{role: 'system', content: SUMMARIZE},
					{role: 'user', content: `${toTranscript(entries.slice(0, cut))}\n\n${SUMMARIZE_NOW}`},
				],
				tools: [],
				maxTokens: MAX_TOKENS,
				timeoutMs: TIMEOUT_MS,
			}),
		);
		const written = $(await appendSummary(job.id, workerId, job.threadId, summary, last.seq));
		if (!written) {
			return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
		}
		return $(await listEntries(job.threadId));
	});
}

// The model's turn on the log, summarized first where it has grown long, with the system prompt
// it was sent.
function askOnLog(job: JobRow, workerId: string, thread: ThreadRow, entries: EntryRow[], key: string, now: Date): Promise<Result<{turn: ModelTurn; system: string}, ApiError>> {
	return Do(async ($) => {
		const current = $(await compact(job, workerId, entries, key));
		const system = $(await systemPrompt(thread, now));
		const turn = $(
			await askForTurn({key, messages: [{role: 'system', content: system}, ...toMessages(current, {clearOld: true})], tools: toolsFor(thread), maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS}),
		);
		return {turn, system};
	});
}

/** Runs the job: one turn of the model on its thread's log, written back; nothing when the thread is done, or gone. */
export function runInference(job: JobRow, workerId: string, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const thread = $(await getJobThread(job.threadId));
		if (!thread || thread.finishedAt !== null) {
			$(await finishJob(job.id, workerId));
			return;
		}
		const entries = $(await listEntries(thread.id));
		if (turnsAlone(entries) >= MAX_TURNS_ALONE) {
			$(await answerWith(job, workerId, thread.parentThreadId === null ? TOO_LONG : TOO_LONG_SUB));
			return;
		}
		const key = env.OPENROUTER_KEY;
		if (!key) {
			$(await answerWith(job, workerId, NOT_SET_UP));
			return;
		}
		const asked = await askOnLog(job, workerId, thread, entries, key, now);
		if (asked.isErr() && asked.error.kind !== 'provider_unreachable') {
			return $(Err(asked.error));
		}
		if (asked.isErr()) {
			log.warn('The built-in agent’s model could not be reached', {attempt: job.attempts, ...serializeError('cause' in asked.error ? asked.error.cause : asked.error)});
			if (job.attempts < MAX_MODEL_ATTEMPTS) {
				$(await requeueJob(job.id, workerId, thread.id, new Date(now.getTime() + RETRY_MS * job.attempts), unreachable(asked.error)));
				return;
			}
			$(await answerWith(job, workerId, UNREACHABLE));
			return;
		}
		const {turn, system} = asked.value;
		$(await writeBack(job, workerId, {...said(thread, turn), system}, plans(thread, turn.toolCalls, now)));
	});
}
