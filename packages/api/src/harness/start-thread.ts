import type {Result} from 'ts-results-es';

import {type ApiError, Do} from '@proxy/utils';
import {startThreadArgs} from '@proxy/utils/harness';
import type {ThreadRow} from '@proxy/db/harness';

import {requireAppUrl} from '../oauth/oauth-config';
import type {HarnessStore} from './store';
import {threadOpening} from './thread-rules';
import {error, type ToolAnswer} from './tool-answers';

/**
 * A thread's agent starting another thread in the member's chat with the same persona, for a
 * piece of work apart from its own: the new thread is titled and tasked from what it is to work
 * on, as the member's message would title and task it (thread-rules.ts threadOpening), opened with
 * it as their message would be, and marked as started from this thread, which the Chat page shows.
 * Its agent starts on it at once, with nothing of this thread but that.
 * The thread it came from is answered with its title and its page in Chat.
 */

/** What starting a thread needs of the store. */
export type StartThreadStore = Pick<HarnessStore, 'startThread' | 'getOrgSlug'>;

export const BAD_START_THREAD_ARGS = 'Give text, what the new thread is to work on.';
export const NOT_A_CHAT_THREAD = 'This is not a thread of a chat, so no thread can be started from it.';

/** Starts the thread a start_thread call asks for, from `thread`, and says where it is. */
export function startThreadCall(store: StartThreadStore, thread: ThreadRow, args: Record<string, unknown>): Promise<Result<ToolAnswer, ApiError>> {
	return Do(async ($) => {
		const said = startThreadArgs(args);
		if (said === null) {
			return error(BAD_START_THREAD_ARGS);
		}
		const opening = threadOpening(thread, {text: said.text, files: []});
		const started = $(await store.startThread(thread.id, said.text, opening));
		if (started === null) {
			return error(NOT_A_CHAT_THREAD);
		}
		const appUrl = $(requireAppUrl());
		const slug = $(await store.getOrgSlug(thread.orgId));
		const where = slug === null ? `its id is ${started.id}` : `${appUrl}/${slug}/chat/${started.personaId}/threads/${started.id}`;
		return {text: `Started the thread “${started.title ?? opening.title}”: ${where}. Its agent works on it from there; nothing of it comes back here.`, isError: false};
	});
}
