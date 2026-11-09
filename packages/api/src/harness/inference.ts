import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, type ChatModel, Do, requirePresent} from '@proxy/utils';
import type {AssistantTurn, CallPlan, EntryRow, JobRow, SubAgentRow, ThreadRow} from '@proxy/db/harness';

import {askForTurn, type ModelTurn} from '../llm/open-router';
import {agentInstructions} from '../mcp/tools';
import {log, serializeError} from '../observability/log';
import {env} from '../utils/env';
import {compactionCut, toMessages, toTranscript} from '@proxy/utils/harness-context';
import {alertsParagraph} from './alerts';
import {afterAnswer, planCalls} from './conversation';
import type {HarnessStore} from './store';
import {toolsFor} from './tool-surface';

/**
 * An inference job: the model, run once on a thread's log, which is ready for it, every call
 * answered, and changes under it only by what the job itself writes (db/harness). Its answer goes
 * in the log as an assistant entry, with each call it made planned (conversation.ts planCall): a
 * tool job, due now or, for a sleep, when the sleep ends; or an answer at once, which is what
 * starting a sub-agent gets, with its id, a message to one, with what it was up to, a message to
 * the agent a sub-agent works for, and a call with arguments that are no good. A log that has
 * grown long is first summarized, in a summary entry the model reads in place of what it covers. A
 * model that can't be reached is tried again a few times, then the person is told; any other
 * failure fails the job, which tells them too (conversation.ts failureNote). A sub-agent's answer
 * with no calls goes to the agent it works for, and stops its work for now, unless a message came
 * while it answered. An answer of nothing, no words and no calls, is written as that said: the
 * person would otherwise see nothing, and the model refuses a log with an empty turn in it. The
 * model is the thread's persona's, read at each turn, a sub-agent's the persona's it works as:
 * Claude, or GLM for a persona of an insider that was switched to it. The answer is written with the system prompt the model was sent, which is built
 * from the login's grants as they are then and, for the agent talking with the person, its
 * sub-agents as they are then, so that what the model read can be told later; the rest of the
 * request is rebuilt from the log. The agent talking with the person is told the alerts set in the
 * conversation too, by id, so it can cancel one.
 */

/** What an inference job needs of the store. */
export type InferenceStore = Pick<
	HarnessStore,
	'getJobThread' | 'getThreadAgent' | 'getChatModel' | 'listEntries' | 'listSubAgents' | 'listThreadAlerts' | 'finishJob' | 'requeueJob' | 'appendSummary' | 'completeInference'
>;

// How the agent talking with the person is to go about it: it does nothing itself, and hands
// every piece of work to a sub-agent, which it can go on talking with.
const MAIN_FLOW =
	'You are chatting with the person on Personal Agent Proxy’s Chat page. Answer in short Markdown: sentences, a list or table where clearer, no headings. You can’t reach their accounts yourself: sub-agents do it for you, so the pap calls these instructions name go in a sub-agent’s brief. Give one question to one sub-agent, even across accounts; start several only for separate, sizeable jobs. A stopped sub-agent keeps what it found: message it for follow-ups rather than starting another. While sub-agents work, tell the person in a few words what you are looking into, and stop. Never mention sub-agents, briefs or messages: to the person, you do the work. When a sub-agent’s message needs no word to the person yet, as while others are still at work, answer with nothing. For something at a time, or something new in their accounts, set an alert rather than a sub-agent. Don’t mention summaries of the conversation.';

// How a sub-agent is to go about it: a brief, its tools, messages to and from the agent it works
// for, and an answer when it stops.
const SUB_FLOW =
	'You are a sub-agent of the Chat agent of Personal Agent Proxy. Your brief and every later message come from that agent; the person doesn’t see what you write. Work in scripts; check pap.tools before using a tool you haven’t used. Your task is kept for you. To ask something you can’t go on without, answer with the question and no tool call. Your first answer without a tool call is handed to the agent and stops you: say what you did and found, with the names, ids, dates and numbers that matter, and what you couldn’t do. A later message takes you up again with this log.';

// How a long log is summarized, by the same model, for itself: a conversation's, or a
// sub-agent's, whose messages from the person are from the agent it works for.
const SUMMARIZE =
	'Summarize this conversation between a person and their agent, with the agent’s calls and their answers, so the agent can go on from the summary alone. Keep what the person asked for and wants; what was done and found, with names, ids, dates and numbers; what they were told; and what is still open or planned, such as after a sleep or a sub-agent’s answer, and which sub-agent ids are on what. Plain prose, from the agent’s side, no title.';
const SUMMARIZE_NOW = 'Write the summary now.';

// How many answers the model may give in a row without the person saying anything, calls,
// sub-agents' messages and wake-ups included, before it stops and waits for them; a message that
// comes after the stop is acted on, and the count starts over. For a sub-agent, the person is the
// agent it works for, whose messages are what it hears.
const MAX_TURNS_ALONE = 30;

// How often a model that can't be reached is tried, and how long to wait between tries.
const MAX_MODEL_ATTEMPTS = 3;
const RETRY_MS = 5_000;

const MAX_TOKENS = 4000;
const TIMEOUT_MS = 120_000;

const NOT_SET_UP = 'Chat is not set up on this server: it needs an OpenRouter key (OPENROUTER_KEY). Everything else works as before.';
const UNREACHABLE = 'The model could not be reached. Say something to try again.';
const TOO_LONG = `I have taken ${MAX_TURNS_ALONE} steps without hearing from you, so I have stopped. Tell me to go on if you want me to.`;
const TOO_LONG_SUB = `I took ${MAX_TURNS_ALONE} steps without hearing from you, so I stopped. This is not a complete answer: tell me to go on if you want me to.`;
const NOTHING = 'I had nothing to say to that. Say something to go on.';
const NOTHING_SUB = 'I stopped without saying anything.';

// Whether the answer is the model stopping for the person, at the cap: the count starts over
// from it, so a sub-agent's message that comes after the stop is acted on rather than answered
// with the stop again, once per message.
function isStop(entry: EntryRow): boolean {
	return entry.kind === 'assistant' && (entry.text === TOO_LONG || entry.text === TOO_LONG_SUB);
}

// How many answers the model has given since the person last spoke, or since it last stopped for
// them.
function turnsAlone(entries: EntryRow[]): number {
	const since = entries.findLastIndex((entry) => entry.kind === 'person' || isStop(entry));
	return entries.slice(since + 1).filter((entry) => entry.kind === 'assistant').length;
}

// The answer as it goes in the log: an answer of nothing says so, but for the agent talking with
// the person woken by a sub-agent's message or an alert rather than by them, which may let it pass
// in silence; the page shows no answer without words, and the model doesn't read it again.
function said(thread: ThreadRow, entries: EntryRow[], turn: ModelTurn): ModelTurn {
	if (turn.text.trim() !== '' || turn.toolCalls.length > 0) {
		return turn;
	}
	if (thread.parentThreadId !== null) {
		return {...turn, text: NOTHING_SUB};
	}
	if (entries.findLast((entry) => entry.kind === 'person' || entry.kind === 'event')?.kind === 'event') {
		return {...turn, text: ''};
	}
	return {...turn, text: NOTHING};
}

// Writes the answer back, with what follows it; a job no longer the worker's is a conflict.
function writeBack(store: InferenceStore, job: JobRow, workerId: string, thread: ThreadRow, turn: AssistantTurn, callPlans: Record<string, CallPlan>): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		if (!$(await store.completeInference(job.id, workerId, job.threadId, turn, afterAnswer(thread, turn, callPlans)))) {
			return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
		}
	});
}

// Answers the person with `text` alone, as the model would, when the model can't be run: no
// prompt was built.
function answerWith(store: InferenceStore, job: JobRow, workerId: string, thread: ThreadRow, text: string): Promise<Result<void, ApiError>> {
	return writeBack(store, job, workerId, thread, {text, toolCalls: [], inputTokens: 0, outputTokens: 0, system: null}, {});
}

// A sub-agent as the roster has it: its id, its title, and what it is up to.
function rosterLine(subAgent: SubAgentRow): string {
	const doing = subAgent.state.kind === 'working' ? 'at work' : subAgent.state.kind === 'asleep' ? `asleep until ${subAgent.state.until.toISOString()}` : 'stopped';
	return `- ${subAgent.id}: “${subAgent.title ?? ''}”, ${doing}`;
}

// How many of the sub-agents that have stopped the roster lists, the latest: a long conversation
// starts more than its prompt should carry, and those at work or asleep are listed whatever their
// number.
const MAX_STOPPED_LISTED = 10;

// The main agent's sub-agents, for its system prompt: what it has started, by id, and what each
// is doing now, which a summary of the conversation might have lost; of those that have stopped,
// the latest, with how many older ones there are.
function roster(subAgents: SubAgentRow[]): string {
	if (subAgents.length === 0) {
		return 'No sub-agents yet.';
	}
	const stopped = subAgents.filter((subAgent) => subAgent.state.kind === 'stopped');
	const unlisted = new Set(stopped.slice(0, -MAX_STOPPED_LISTED).map((subAgent) => subAgent.id));
	const listed = subAgents.filter((subAgent) => !unlisted.has(subAgent.id)).map(rosterLine);
	const older = unlisted.size === 0 ? [] : [`- ${unlisted.size} older stopped ones, not listed`];
	return `Sub-agents:\n${[...older, ...listed].join('\n')}`;
}

// Why the model couldn't be reached, for the job's record.
function unreachable(failure: ApiError): string {
	const cause = 'cause' in failure ? failure.cause : null;
	return `The model could not be reached${cause instanceof Error ? `: ${cause.message}` : ''}`;
}

// The system prompt: the instructions any agent with the login gets, for the agent as it acts in
// the thread, as the member whose conversation it is, how to go about it on this thread, and, for
// the agent talking with the person, its sub-agents and the alerts set in the conversation.
function systemPrompt(store: InferenceStore, thread: ThreadRow, subAgents: SubAgentRow[], now: Date): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const signedIn = $(requirePresent($(await store.getThreadAgent(thread)), ApiErr.notFound('agent', thread.agentId)));
		const instructions = $(await agentInstructions(signedIn, thread.parentThreadId === null ? MAIN_FLOW : SUB_FLOW));
		const about = thread.parentThreadId === null ? [roster(subAgents), alertsParagraph($(await store.listThreadAlerts(thread.id)))] : [];
		return [instructions, ...about, `The time now is ${now.toISOString()}.`].join('\n\n');
	});
}

// Summarizes the log where it has grown long, into a summary entry the model reads in place of
// what it covers; the log then, as it is. The model gets the log as text, not as the turns it
// made, which would need the tools sent along: a request with calls in it and no tools is refused.
function compact(store: InferenceStore, job: JobRow, workerId: string, entries: EntryRow[], subAgents: SubAgentRow[], key: string, model: ChatModel): Promise<Result<EntryRow[], ApiError>> {
	return Do(async ($) => {
		const cut = compactionCut(entries);
		const last = cut === null ? undefined : entries[cut - 1];
		if (cut === null || !last) {
			return entries;
		}
		const summary = $(
			await askForTurn({
				key,
				model,
				messages: [
					{role: 'system', content: SUMMARIZE},
					{role: 'user', content: `${toTranscript(entries.slice(0, cut), subAgents)}\n\n${SUMMARIZE_NOW}`},
				],
				tools: [],
				maxTokens: MAX_TOKENS,
				timeoutMs: TIMEOUT_MS,
			}),
		);
		const written = $(await store.appendSummary(job.id, workerId, job.threadId, summary, last.seq));
		if (!written) {
			return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
		}
		return $(await store.listEntries(job.threadId));
	});
}

// The model's turn on the log, summarized first where it has grown long, with the system prompt
// it was sent. The thread's sub-agents are read once, for the prompt and for whose each message
// in the log is; a sub-agent's thread has none.
function askOnLog(store: InferenceStore, job: JobRow, workerId: string, thread: ThreadRow, entries: EntryRow[], key: string, now: Date): Promise<Result<{turn: ModelTurn; system: string}, ApiError>> {
	return Do(async ($) => {
		const model = $(await store.getChatModel(thread));
		const subAgents = thread.parentThreadId === null ? $(await store.listSubAgents(thread.id, now)) : [];
		const current = $(await compact(store, job, workerId, entries, subAgents, key, model));
		const system = $(await systemPrompt(store, thread, subAgents, now));
		const turn = $(
			await askForTurn({
				key,
				model,
				messages: [{role: 'system', content: system}, ...toMessages(current, subAgents, {clearOld: true})],
				tools: toolsFor(thread),
				maxTokens: MAX_TOKENS,
				timeoutMs: TIMEOUT_MS,
			}),
		);
		return {turn, system};
	});
}

/** Runs the job: one turn of the model on its thread's log, written back; nothing when the thread is gone. */
export function runInference(store: InferenceStore, job: JobRow, workerId: string, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const thread = $(await store.getJobThread(job.threadId));
		if (!thread) {
			$(await store.finishJob(job.id, workerId));
			return;
		}
		const entries = $(await store.listEntries(thread.id));
		if (turnsAlone(entries) >= MAX_TURNS_ALONE) {
			$(await answerWith(store, job, workerId, thread, thread.parentThreadId === null ? TOO_LONG : TOO_LONG_SUB));
			return;
		}
		const key = env.OPENROUTER_KEY;
		if (!key) {
			$(await answerWith(store, job, workerId, thread, NOT_SET_UP));
			return;
		}
		const asked = await askOnLog(store, job, workerId, thread, entries, key, now);
		if (asked.isErr() && asked.error.kind !== 'provider_unreachable') {
			return $(Err(asked.error));
		}
		if (asked.isErr()) {
			log.warn('The built-in agent’s model could not be reached', {attempt: job.attempts, ...serializeError('cause' in asked.error ? asked.error.cause : asked.error)});
			if (job.attempts < MAX_MODEL_ATTEMPTS) {
				$(await store.requeueJob(job.id, workerId, thread.id, new Date(now.getTime() + RETRY_MS * job.attempts), unreachable(asked.error)));
				return;
			}
			$(await answerWith(store, job, workerId, thread, UNREACHABLE));
			return;
		}
		const {turn, system} = asked.value;
		$(await writeBack(store, job, workerId, thread, {...said(thread, entries, turn), system}, planCalls(thread, turn.toolCalls, now)));
	});
}
