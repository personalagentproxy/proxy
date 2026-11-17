import {setTimeout as sleep} from 'node:timers/promises';

import {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do} from '@proxy/utils';
import {cut} from '@proxy/utils/harness';

import type {JsonRequest} from '../llm/open-router';
import {log, serializeError} from '../observability/log';
import type {HarnessStore} from './store';
import {SHOWN_CALLS} from './thread-rules';
import {inTime, threadForModel} from './thread-standing';

/**
 * A thread's title, a few words naming the work it is about, for the chat's list, the title bar of
 * the thread open beside it and its task in the activity log. A thread opens named by a line of the
 * member's message (thread-rules.ts threadOpening); as its first turn starts, the worker has a small
 * model read what the thread shows, the message alone for one just opened, and name it, beside the
 * turn rather than before it, so the agent starts at once (worker.ts). It is written once: a turn
 * after that asks nothing. The model is the one that reads where a thread stands
 * (thread-standing.ts), through `askForJson` (llm/open-router.ts) on the server's OpenRouter key.
 * Without the key nothing is asked, and the thread keeps the line of its message; a failure, an
 * answer outside the form or no answer in time is logged, and the model asked once more, the next
 * turn trying again where that fails too.
 */

/** What naming a thread needs of the store: the thread as the member sees it, whether it needs a title, and the write. */
export type TitleStore = Pick<HarnessStore, 'getJobThread' | 'getChatThread' | 'threadNeedsTitle' | 'writeThreadTitle'>;

const titleSchema = z.object({title: z.string()});

/** What the model answers: the title. */
export type Title = z.infer<typeof titleSchema>;

/** The model that names a thread: the server's OpenRouter key, undefined without one, the call it is asked through (askForJson), how long it may take, and how long after a failure it is asked again. */
export type TitleModel = {
	key: string | undefined;
	ask: (request: JsonRequest<Title>) => Promise<Result<Title, ApiError>>;
	timeoutMs?: number;
	retryMs?: number;
};

// The title shows while the agent is still at its first step: it should come within a moment.
const TIMEOUT_MS = 10_000;

// How many times the start of a turn tries to name its thread, and how long it waits between.
const ATTEMPTS = 2;
const RETRY_MS = 2_000;

// Its thinking and the answer: a few words.
const MAX_TOKENS = 800;

// How long a title is kept at most, as a line of the message is (thread-rules.ts).
const MAX_TITLE = 80;

/** What the model is told: what a title is, with examples. */
export const TITLE_INSTRUCTIONS = [
	'You read a thread between a person and an AI agent that works for them, as the person sees it, and name it for the list of their threads, as an email has a subject. Answer with JSON only.',
	'title: two to five words naming the piece of work or what it is about, so the person can find it again in a list: as short as it can be while it stays clear, leaving out times, amounts and other details, which the line under it carries. A natural phrase, as a person would write a subject line, not a string of keywords: "Flights to Porto in May", not "Porto flights May". Name the subject rather than repeating the request: no "Request to", "Help with", "Question about" or "Can you". Sentence case, no period at the end, no quotes, no emoji; keep a number, name or # reference that singles it out. Write it in the language of the thread. For example: "Overdue invoices from Acme" for "which of acme\'s invoices are past due?", "Offsite venues in Lisbon" for "find 3 venues in lisbon for a 20 person offsite in june", "Fix for the flaky login test" for "the login test on main keeps failing, can you fix it", "Rückzahlung der Kaution" for "hat der Vermieter die Kaution schon überwiesen?".',
].join('\n\n');

const jsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['title'],
	properties: {title: {type: 'string'}},
};

/** The model's title as the thread keeps it: on one line, without quotes or a period around it, cut. */
export function cleanTitle(title: string): string {
	const line = title
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^["'“‘«]+|["'”’»]+$/g, '')
		.replace(/(?<!\.)\.$/, '')
		.trim();
	return cut(line, MAX_TITLE);
}

/** Whether the thread's title was written, or there was nothing to write: no key, no such thread of a chat, one named already, or one with nothing said in it. */
export type TitleWritten = 'written' | 'skipped';

/**
 * Writes the thread's title, as the model names it from what the thread shows. Nothing is asked
 * without the key, for a thread that is no chat's, one named already, or one with nothing in it;
 * an answer with no words leaves the line of the message.
 */
export function writeTitle(store: TitleStore, model: TitleModel, threadId: string, clock: () => Date = () => new Date()): Promise<Result<TitleWritten, ApiError>> {
	return Do(async ($): Promise<TitleWritten> => {
		if (model.key === undefined) {
			return 'skipped';
		}
		if (!$(await store.threadNeedsTitle(threadId))) {
			return 'skipped';
		}
		const row = $(await store.getJobThread(threadId));
		if (row === null || row.parentThreadId === null) {
			return 'skipped';
		}
		const thread = $(await store.getChatThread(row.parentThreadId, threadId, SHOWN_CALLS, clock()));
		const shown = thread === null ? '' : threadForModel(thread);
		if (shown === '') {
			return 'skipped';
		}
		const timeoutMs = model.timeoutMs ?? TIMEOUT_MS;
		const answer = $(await inTime(model.ask({key: model.key, system: TITLE_INSTRUCTIONS, user: shown, name: 'title', jsonSchema, answer: titleSchema, maxTokens: MAX_TOKENS, timeoutMs}), timeoutMs));
		const title = cleanTitle(answer.title);
		if (title === '') {
			return 'skipped';
		}
		return $(await store.writeThreadTitle(threadId, title)) ? 'written' : 'skipped';
	});
}

// One try at naming the thread: what went wrong, for the log, or null where nothing did.
async function titleFailure(store: TitleStore, model: TitleModel, threadId: string): Promise<ReturnType<typeof serializeError> | null> {
	const result = await Result.wrapAsync(() => writeTitle(store, model, threadId));
	if (result.isErr()) {
		return serializeError(result.error);
	}
	if (result.value.isErr()) {
		return serializeError('cause' in result.value.error ? result.value.error.cause : result.value.error);
	}
	return null;
}

/**
 * Names the thread as a turn of it starts, as best it can: it never fails and never throws. What
 * goes wrong is logged, and it is tried once more, a moment later; failing again, the thread keeps
 * the line of its message until its next turn starts.
 */
export async function titleAtTurn(store: TitleStore, model: TitleModel, threadId: string): Promise<void> {
	if (model.key === undefined) {
		return;
	}
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		const failure = await titleFailure(store, model, threadId);
		if (failure === null) {
			return;
		}
		log.warn('The title of a thread could not be written', {threadId, attempt, ...failure});
		if (attempt < ATTEMPTS) {
			await sleep(model.retryMs ?? RETRY_MS);
		}
	}
}

/** How naming the threads from before went: how many were written, left as they were, and failed. */
export type TitledThreads = {written: number; skipped: number; failed: number};

/**
 * Names each of the chats' threads the model has yet to name, the oldest first, one after
 * another, as the start of a turn would: what the one-off script does (scripts/title-threads.ts).
 * One that fails is logged, and the rest go on. `onThread` hears how each went.
 */
export function titleThreadsWithoutTitle(
	store: TitleStore & Pick<HarnessStore, 'listThreadsWithoutTitle'>,
	model: TitleModel,
	onThread: (threadId: string, outcome: TitleWritten | 'failed') => void = () => {},
): Promise<Result<TitledThreads, ApiError>> {
	return Do(async ($) => {
		const threads = $(await store.listThreadsWithoutTitle());
		const counts: TitledThreads = {written: 0, skipped: 0, failed: 0};
		for (const thread of threads) {
			const result = await writeTitle(store, model, thread.id);
			if (result.isErr()) {
				log.warn('The title of a thread could not be written', {threadId: thread.id, ...serializeError('cause' in result.error ? result.error.cause : result.error)});
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
