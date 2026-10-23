import {Err, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {readyForInference, SLEEP_TOOL, sleepUntil, type ToolCall} from '@proxy/utils/harness';
import {appendSummary, completeInference, type EntryRow, finishIdleInference, finishJob, getJobThread, getThreadAgent, type JobRow, listEntries, requeueJob, type ThreadRow} from '@proxy/db/harness';

import {agentInstructions} from '../mcp/tools';
import {log, serializeError} from '../observability/log';
import {env} from '../utils/env';
import {compactionCut, toMessages} from './context';
import {askModel, type ModelTurn} from './model';
import {ensureThreadTask} from './thread-task';
import {MODEL_TOOLS} from './tool-surface';

/**
 * An inference job: the model, run once on a thread's log. Its answer goes in the log as an
 * assistant entry, with a tool job for each call it made; a sleep's job is due when the sleep
 * ends. The log not ready, as when the person spoke while a call was still running, is left for
 * the job the last result queues. A log that has grown long is first summarized, in a summary
 * entry the model reads in place of what it covers. A model that can't be reached is tried again
 * a few times, then the person is told.
 */

// How the built-in agent is to go about it, where an MCP client is told about tasks.
const FLOW =
	'You are talking with the person directly, on the Chat page of Personal Agent Proxy; what you write is shown to them as it is, so write plain text, short, and answer what they asked. list_connections lists the accounts you can use and what you may do with each. list_tools with a connection gives that connection’s tools and their params. read runs the tools that only read; run runs the ones that change something or reach other people. Every call is made for this conversation’s task, filled in for you: there is nothing to start or finish. When you have called sleep_until, you are woken at that time with nothing but this conversation, so say in your message what you will do then. A long conversation is summarized for you as it goes, and older results are cleared from it: take a summary as what happened, and don’t mention that the conversation was summarized.';

// How a long conversation is summarized, by the same model, for itself.
const SUMMARIZE =
	'You are summarizing a conversation between a person and their agent, so that the agent can go on from the summary in place of the conversation so far. Write what the agent needs to go on as if it remembered: what the person asked for and what they said they want in general; what was done and found, with the names, ids, dates and numbers that matter; what the person was told; what is still open, promised or planned, such as what to do after a sleep. Leave out what no longer matters. Plain prose, from the agent’s side, no title.';
const SUMMARIZE_NOW = 'Write the summary now.';

// How many answers the model may give in a row without the person saying anything, calls and
// wake-ups included, before it stops and waits for them.
const MAX_TURNS_ALONE = 30;

// How often a model that can't be reached is tried, and how long to wait between tries.
const MAX_MODEL_ATTEMPTS = 3;
const RETRY_MS = 5_000;

const MAX_TOKENS = 4000;
const TIMEOUT_MS = 120_000;

const NOT_SET_UP = 'Chat is not set up on this server: it needs an OpenRouter key (OPENROUTER_KEY). Everything else works as before.';
const UNREACHABLE = 'The model could not be reached. Say something to try again.';
const TOO_LONG = `I have taken ${MAX_TURNS_ALONE} steps without hearing from you, so I have stopped. Tell me to go on if you want me to.`;

// How many answers the model has given since the person last spoke.
function turnsAlone(entries: EntryRow[]): number {
	const lastPerson = entries.findLastIndex((entry) => entry.kind === 'person');
	return entries.slice(lastPerson + 1).filter((entry) => entry.kind === 'assistant').length;
}

// When each call's job is due: a sleep's when it ends, every other's now.
function dueTimes(calls: ToolCall[], now: Date): Record<string, Date> {
	return Object.fromEntries(
		calls.flatMap((call) => {
			if (call.name !== SLEEP_TOOL) {
				return [];
			}
			const parsed = Result.wrap((): unknown => JSON.parse(call.arguments));
			return [[call.id, (parsed.isOk() ? sleepUntil(parsed.value, now) : null) ?? now]];
		}),
	);
}

// Answers the person with `text` alone, as the model would, when the model can't be run.
function answerWith(job: JobRow, workerId: string, text: string): Promise<Result<boolean, ApiError>> {
	return completeInference(job.id, workerId, job.threadId, {text, toolCalls: [], inputTokens: 0, outputTokens: 0}, {});
}

// The system prompt: the instructions any agent with the login gets, for the agent as it acts in
// the thread, as the member whose conversation it is.
function systemPrompt(thread: ThreadRow, now: Date): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		const signedIn = $(requirePresent($(await getThreadAgent(thread)), ApiErr.notFound('agent', thread.agentId)));
		const instructions = $(await agentInstructions(signedIn, FLOW));
		return `${instructions}\n\nThe time now is ${now.toISOString()}.`;
	});
}

// Summarizes the log where it has grown long, into a summary entry the model reads in place of
// what it covers; the log then, as it is.
function compact(job: JobRow, workerId: string, entries: EntryRow[], key: string): Promise<Result<EntryRow[], ApiError>> {
	return Do(async ($) => {
		const cut = compactionCut(entries);
		const last = cut === null ? undefined : entries[cut - 1];
		if (cut === null || !last) {
			return entries;
		}
		const summary = $(
			await askModel({
				key,
				messages: [{role: 'system', content: SUMMARIZE}, ...toMessages(entries.slice(0, cut), {clearOld: false}), {role: 'user', content: SUMMARIZE_NOW}],
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

// The model's turn on the log, summarized first where it has grown long.
function askOnLog(job: JobRow, workerId: string, thread: ThreadRow, entries: EntryRow[], key: string, now: Date): Promise<Result<ModelTurn, ApiError>> {
	return Do(async ($) => {
		const current = $(await compact(job, workerId, entries, key));
		const system = $(await systemPrompt(thread, now));
		return $(await askModel({key, messages: [{role: 'system', content: system}, ...toMessages(current, {clearOld: true})], tools: MODEL_TOOLS, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS}));
	});
}

/** Runs the job: one turn of the model on its thread's log, written back; nothing when the log isn't ready. */
export function runInference(job: JobRow, workerId: string, now = new Date()): Promise<Result<void, ApiError>> {
	return Do(async ($) => {
		const thread = $(await getJobThread(job.threadId));
		if (!thread) {
			$(await finishJob(job.id, workerId));
			return;
		}
		const entries = $(await listEntries(thread.id));
		if (!readyForInference(entries)) {
			$(await finishIdleInference(job.id, workerId, thread.id));
			return;
		}
		if (turnsAlone(entries) >= MAX_TURNS_ALONE) {
			$(await answerWith(job, workerId, TOO_LONG));
			return;
		}
		const key = env.OPENROUTER_KEY;
		if (!key) {
			$(await answerWith(job, workerId, NOT_SET_UP));
			return;
		}
		$(await ensureThreadTask(thread, now));
		const turn = await askOnLog(job, workerId, thread, entries, key, now);
		if (turn.isErr() && turn.error.kind !== 'provider_unreachable') {
			return $(Err(turn.error));
		}
		if (turn.isErr()) {
			log.warn('The built-in agent’s model could not be reached', {attempt: job.attempts, ...serializeError('cause' in turn.error ? turn.error.cause : turn.error)});
			if (job.attempts < MAX_MODEL_ATTEMPTS) {
				$(await requeueJob(job.id, workerId, new Date(now.getTime() + RETRY_MS * job.attempts)));
				return;
			}
			$(await answerWith(job, workerId, UNREACHABLE));
			return;
		}
		const written = $(await completeInference(job.id, workerId, thread.id, turn.value, dueTimes(turn.value.toolCalls, now)));
		if (!written) {
			return $(Err(ApiErr.conflict('The job was no longer this worker’s')));
		}
	});
}
