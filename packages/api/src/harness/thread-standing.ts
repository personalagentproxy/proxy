import {setTimeout as sleep} from 'node:timers/promises';

import {Err, Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {ATTACHMENT_MARK, callArguments, cut, personMessageArgs, SEND_TO_PERSON_TOOL} from '@proxy/utils/harness';
import type {ChatThreadRow} from '@proxy/db/harness';

import type {JsonRequest} from '../llm/open-router';
import {log, serializeError} from '../observability/log';
import {SHOWN_CALLS} from './thread-rules';
import type {HarnessStore} from './store';

/**
 * Where a thread stands, written as its turn ends, whichever harness ran it and however it ended,
 * its answer without calls or a failure answered in the thread (worker.ts): one sentence saying
 * where it is, for the chat's list in place of the start of the latest answer, and whether its
 * agent waits for the member to answer or act before it can go on. A small model reads what the
 * member sees of the thread and says both, through `askForJson` (llm/open-router.ts) on the
 * server's OpenRouter key, as the command bar's model fills in a card. It is the turn's after: the
 * turn's result is written before it runs, and nothing it does reaches the turn. Without the key
 * nothing is asked; a failure, an answer outside the form or no answer in time is logged, and the
 * model asked once more; failing again, the thread is then done with no summary, as a reply or an
 * alert that took it up left it (db/harness wakeWith). What is written is written up to the last thing said in the thread, and
 * only while nothing came since (db/harness writeThreadStanding): a summary is shown only while it
 * is current. The member's Done button overrides whether it waits.
 */

/** What writing where a thread stands needs of the store: the thread as the member sees it, and the write. */
export type StandingStore = Pick<HarnessStore, 'getJobThread' | 'getChatThread' | 'writeThreadStanding'>;

const standingSchema = z.object({summary: z.string(), waitingForMember: z.boolean()});

/** What the model answers: the sentence, and whether the thread waits for the member. */
export type Standing = z.infer<typeof standingSchema>;

/** The model that reads a thread: the server's OpenRouter key, undefined without one, the call it is asked through (askForJson), how long it may take, and how long after a failure it is asked again. */
export type StandingModel = {
	key: string | undefined;
	ask: (request: JsonRequest<Standing>) => Promise<Result<Standing, ApiError>>;
	timeoutMs?: number;
	retryMs?: number;
};

// How long the model may take: a turn's end is not held up by it, but a thread's word over it
// should change while the member is still looking.
const TIMEOUT_MS = 20_000;

// How many times a turn's end tries to write where its thread stands, and how long it waits
// between: a model that failed or was late once often answers the next time.
const ATTEMPTS = 2;
const RETRY_MS = 2_000;

/**
 * How long after a thread's turn ended where it stands may still be written: every attempt taking
 * all its time, with the reads and the write around them. Until then a list of the thread reads it
 * again (route.ts).
 */
export const STANDING_WITHIN_MS = ATTEMPTS * TIMEOUT_MS + (ATTEMPTS - 1) * RETRY_MS + 8_000;

// Its thinking and the answer: a sentence and a yes or no.
const MAX_TOKENS = 1500;

// How much of the thread the model reads at most, and of any one message in it: what opened the
// thread, then the newest messages that fit, as what the thread came to is at its end.
const MAX_THREAD_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 3_000;

// How long a summary is kept at most.
const MAX_SUMMARY = 300;

/** What the model is told: what to write, and when a thread waits for the member. */
export const STANDING_INSTRUCTIONS = [
	'You read a thread between a person and an AI agent that works for them, as the person sees it, and say where it stands, for the list of their threads. Answer with JSON only.',
	'summary: one sentence, at most 20 words, saying where the thread stands now: what was done or found, with the number, name or link that matters, or what the agent asks. Clipped and factual, about the thread rather than its last message; no "The agent", no "I", no greeting. Write it in the language of the thread. For example: "Has a plan, and asks whether the date range should cover the CSV export too." "Merged #412 once its checks passed." "81% of lines and 74% of branches."',
	'waitingForMember: true when the agent stopped and can not go on until the person answers a question, decides something or does something it asked of them; false when it finished, reported, or needs nothing more from them.',
].join('\n\n');

const jsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['summary', 'waitingForMember'],
	properties: {summary: {type: 'string'}, waitingForMember: {type: 'boolean'}},
};

// What the member sees of the thread, each a line by who said it: what they said, with the names
// of the files they attached; an alert that came into it; what the agent answered, and what it told
// them as it went. Each cut to a length.
function messagesOf(thread: ChatThreadRow): string[] {
	return thread.entries.flatMap((entry) => {
		if (entry.kind === 'person') {
			const files = thread.attachments.filter((attachment) => attachment.entryId === entry.id).map((attachment) => attachment.name);
			const text = entry.text.replaceAll(ATTACHMENT_MARK, ' ').trim();
			return [`Person: ${cut(text, MAX_MESSAGE_CHARS)}${files.length === 0 ? '' : ` [attached: ${files.join(', ')}]`}`];
		}
		if (entry.kind === 'event') {
			return [`Alert: ${cut(entry.text, MAX_MESSAGE_CHARS)}`];
		}
		if (entry.kind !== 'assistant') {
			return [];
		}
		const said = entry.text === '' ? [] : [`${entry.isError ? 'Agent (failed)' : 'Agent'}: ${cut(entry.text, MAX_MESSAGE_CHARS)}`];
		const told = (entry.toolCalls ?? []).flatMap((call) => {
			const message = call.name === SEND_TO_PERSON_TOOL ? personMessageArgs(callArguments(call)) : null;
			return message ? [`Agent: ${cut(message.text, MAX_MESSAGE_CHARS)}`] : [];
		});
		return [...said, ...told];
	});
}

/** The thread as the model reads it: what opened it, then the newest messages that fit in what it reads at most, a line saying so where some between are left out. */
export function threadForModel(thread: ChatThreadRow): string {
	const [first, ...rest] = messagesOf(thread);
	if (first === undefined) {
		return '';
	}
	const kept: string[] = [];
	let left = MAX_THREAD_CHARS - first.length;
	for (const message of rest.toReversed()) {
		if (message.length > left) {
			break;
		}
		kept.unshift(message);
		left -= message.length;
	}
	const skipped = rest.length - kept.length;
	return [first, ...(skipped === 0 ? [] : [`(${skipped} earlier ${skipped === 1 ? 'message' : 'messages'} left out)`]), ...kept].join('\n\n');
}

// The model's answer, or a failure where it gives none in `ms`.
async function inTime<T>(work: Promise<Result<T, ApiError>>, ms: number): Promise<Result<T, ApiError>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<Result<T, ApiError>>((resolve) => {
		timer = setTimeout(() => resolve(Err(ApiErr.providerUnreachable(new Error(`The model gave no answer in ${ms} ms`)))), ms);
	});
	return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Whether where the thread stands was written, or there was nothing to write: no key, no such thread, one at work, or one whose summary is current. */
export type StandingWritten = 'written' | 'skipped';

/**
 * Writes where the thread stands, as the model reads it: the sentence, and, with `decideWaiting`,
 * whether it waits for the member; left as it is otherwise, as for a thread from before, whose
 * standing nobody read. Nothing is asked without the key, for a thread at work, one with nothing
 * said in it, or one whose summary is current already.
 */
export function writeStanding(store: StandingStore, model: StandingModel, threadId: string, decideWaiting = true, clock: () => Date = () => new Date()): Promise<Result<StandingWritten, ApiError>> {
	return Do(async ($): Promise<StandingWritten> => {
		if (model.key === undefined) {
			return 'skipped';
		}
		const row = $(await store.getJobThread(threadId));
		if (row === null || row.parentThreadId === null) {
			return 'skipped';
		}
		const thread = $(await store.getChatThread(row.parentThreadId, threadId, SHOWN_CALLS, clock()));
		if (thread === null || thread.state.kind !== 'stopped' || thread.entries.some((entry) => entry.pending)) {
			return 'skipped';
		}
		const upToSeq = Math.max(0, ...thread.entries.map((entry) => entry.seq));
		const {summary, summarySeq} = thread.standing;
		if (thread.entries.length === 0 || (summary !== null && summarySeq !== null && summarySeq >= upToSeq)) {
			return 'skipped';
		}
		const answer = $(
			await inTime(
				model.ask({
					key: model.key,
					system: STANDING_INSTRUCTIONS,
					user: threadForModel(thread),
					name: 'standing',
					jsonSchema,
					answer: standingSchema,
					maxTokens: MAX_TOKENS,
					timeoutMs: model.timeoutMs ?? TIMEOUT_MS,
				}),
				model.timeoutMs ?? TIMEOUT_MS,
			),
		);
		const sentence = cut(answer.summary.replace(/\s+/g, ' ').trim(), MAX_SUMMARY);
		const standing = {summary: sentence === '' ? null : sentence, ...(decideWaiting ? {waitingForMember: answer.waitingForMember} : {})};
		return $(await store.writeThreadStanding(threadId, standing, upToSeq)) ? 'written' : 'skipped';
	});
}

/** How writing the summaries of threads from before went: how many were written, left as they were, and failed. */
export type SummarizedThreads = {written: number; skipped: number; failed: number};

/**
 * Writes a summary for each of the chats' threads that has none, the oldest first, one after
 * another, as a turn's end would, but leaving whether it waits as it is: what the one-off script
 * after the threads came does (scripts/summarize-threads.ts). A thread at work is left for its
 * turn's end; one that fails is logged, and the rest go on. `onThread` hears how each went.
 */
export function summarizeThreadsWithoutSummary(
	store: StandingStore & Pick<HarnessStore, 'listThreadsWithoutSummary'>,
	model: StandingModel,
	onThread: (threadId: string, outcome: StandingWritten | 'failed') => void = () => {},
): Promise<Result<SummarizedThreads, ApiError>> {
	return Do(async ($) => {
		const threads = $(await store.listThreadsWithoutSummary());
		const counts: SummarizedThreads = {written: 0, skipped: 0, failed: 0};
		for (const thread of threads) {
			const result = await writeStanding(store, model, thread.id, false);
			if (result.isErr()) {
				log.warn('The summary of a thread could not be written', {threadId: thread.id, ...serializeError('cause' in result.error ? result.error.cause : result.error)});
				counts.failed += 1;
				onThread(thread.id, 'failed');
				continue;
			}
			counts[result.value] += 1;
			onThread(thread.id, result.value);
		}
		return counts;
	});
}

// One try at writing where the thread stands: what went wrong, for the log, or null where nothing did.
async function standingFailure(store: StandingStore, model: StandingModel, threadId: string): Promise<ReturnType<typeof serializeError> | null> {
	const result = await Result.wrapAsync(() => writeStanding(store, model, threadId));
	if (result.isErr()) {
		return serializeError(result.error);
	}
	if (result.value.isErr()) {
		return serializeError('cause' in result.value.error ? result.value.error.cause : result.value.error);
	}
	return null;
}

/**
 * Writes where the thread stands as a job of its turn has ended, as best it can: it never fails
 * and never throws. What goes wrong is logged, and it is tried once more, a moment later; failing
 * again, the thread is left done, with no summary.
 */
export async function standAfterTurn(store: StandingStore, model: StandingModel, threadId: string): Promise<void> {
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		const failure = await standingFailure(store, model, threadId);
		if (failure === null) {
			return;
		}
		log.warn('Where a thread stands could not be written', {threadId, attempt, ...failure});
		if (attempt < ATTEMPTS) {
			await sleep(model.retryMs ?? RETRY_MS);
		}
	}
}
