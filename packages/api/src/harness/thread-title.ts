import {setTimeout as sleep} from 'node:timers/promises';

import {Result} from 'ts-results-es';
import {z} from 'zod';

import {type ApiError, Do} from '@proxy/utils';
import {ATTACHMENT_MARK, cut} from '@proxy/utils/harness';

import type {JsonRequest} from '../llm/open-router';
import {log, serializeError} from '../observability/log';
import type {HarnessStore} from './store';
import {SHOWN_CALLS} from './thread-rules';
import {inTime} from './thread-standing';

/**
 * A thread's title, written as its first turn starts, beside it: a small model reads the message
 * that opened the thread and names the piece of work in a few words, which the chat's list shows in
 * place of the message and the thread's header shows as its name; the message stays in the thread
 * as it was written. Until then, and where it can't be written, the title is the line of the
 * message the thread was opened with (thread-rules.ts threadOpening), and the list shows the
 * message. It is asked through `askForJson` (llm/open-router.ts) on the server's OpenRouter key, as
 * where a thread stands is (thread-standing.ts); without the key nothing is asked. A title is
 * written once: a thread that has one is left as it is.
 */

/** What writing a thread's title needs of the store: the thread as the member sees it, and the write. */
export type TitleStore = Pick<HarnessStore, 'getJobThread' | 'getChatThread' | 'writeThreadTitle'>;

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

// How long the model may take, how many times it is asked, and how long it waits between.
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 2;
const RETRY_MS = 2_000;

// Its thinking and the answer: a few words.
const MAX_TOKENS = 800;

// How much of the message the model reads, and how long a title is kept at most.
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TITLE = 80;

/** What the model is told: what a title is. */
export const TITLE_INSTRUCTIONS = [
	'You read the message that opened a thread between a person and an AI agent that works for them, and name the piece of work for the list of their threads. Answer with JSON only.',
	'title: at most 8 words, saying what the thread is for, as a heading would: a noun phrase or a short imperative, with the name, number or place that tells it apart. No trailing period, no quotes, no "Request to", no greeting. Write it in the language of the message. For example: "Date filter for the activity log" "Book a table for four on Friday" "Renew the passport before February".',
].join('\n\n');

const jsonSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['title'],
	properties: {title: {type: 'string'}},
};

/** Whether the title was written, or there was nothing to write: no key, no such thread, one titled already, or one with nothing that opened it. */
export type TitleWritten = 'written' | 'skipped';

/** Writes the thread's title as the model names it, once; nothing is asked without the key, or for a thread that has one. */
export function writeTitle(store: TitleStore, model: TitleModel, threadId: string, clock: () => Date = () => new Date()): Promise<Result<TitleWritten, ApiError>> {
	return Do(async ($): Promise<TitleWritten> => {
		if (model.key === undefined) {
			return 'skipped';
		}
		const row = $(await store.getJobThread(threadId));
		if (row === null || row.parentThreadId === null) {
			return 'skipped';
		}
		const thread = $(await store.getChatThread(row.parentThreadId, threadId, SHOWN_CALLS, clock()));
		const opener = thread?.entries[0];
		if (!thread || thread.titleWritten || opener === undefined || opener.kind !== 'person') {
			return 'skipped';
		}
		const files = thread.attachments.filter((attachment) => attachment.entryId === opener.id).map((attachment) => attachment.name);
		const words = cut(opener.text.replaceAll(ATTACHMENT_MARK, ' ').trim(), MAX_MESSAGE_CHARS);
		const answer = $(
			await inTime(
				model.ask({
					key: model.key,
					system: TITLE_INSTRUCTIONS,
					user: files.length === 0 ? words : `${words}\n\n[attached: ${files.join(', ')}]`,
					name: 'title',
					jsonSchema,
					answer: titleSchema,
					maxTokens: MAX_TOKENS,
					timeoutMs: model.timeoutMs ?? TIMEOUT_MS,
				}),
				model.timeoutMs ?? TIMEOUT_MS,
			),
		);
		const title = cut(
			answer.title
				.replace(/\s+/g, ' ')
				// Quotes around it and a period after it, which a heading has none of.
				.replace(/^[\s"“”'‘’]+|[\s"“”'‘’.]+$/g, ''),
			MAX_TITLE,
		);
		if (title === '') {
			return 'skipped';
		}
		return $(await store.writeThreadTitle(threadId, title)) ? 'written' : 'skipped';
	});
}

/**
 * Writes the thread's title as its first turn starts, as best it can: it never fails and never
 * throws. What goes wrong is logged, and it is tried once more, a moment later; failing again,
 * the thread keeps the line of its message.
 */
export async function titleAtStart(store: TitleStore, model: TitleModel, threadId: string): Promise<void> {
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		const result = await Result.wrapAsync(() => writeTitle(store, model, threadId));
		const failure = result.isErr() ? result.error : result.value.isErr() ? result.value.error : null;
		if (failure === null) {
			return;
		}
		log.warn('The title of a thread could not be written', {threadId, attempt, ...serializeError(typeof failure === 'object' && failure !== null && 'cause' in failure ? failure.cause : failure)});
		if (attempt < ATTEMPTS) {
			await sleep(model.retryMs ?? RETRY_MS);
		}
	}
}
