import {Result} from 'ts-results-es';

import type {SdkSessionStore, SessionStoreEntry} from '@proxy/backends/harness/session-store';
import type {ApiError} from '@proxy/utils';
import {isRecord, jsonValueSchema} from '@proxy/utils/harness';

import type {TranscriptStore} from './store';

/**
 * The Claude Agent SDK's session store, on the database: what the SDK writes its transcripts
 * through when it is given one instead of its files, so that a thread's session can be resumed
 * from any api instance. The store's shape is the SDK's, as @proxy/backends/harness/session-store
 * has it, which the SDK harness there gives the SDK. Each line is kept as it was given,
 * serialized; a line with a uuid is kept once, since the SDK may deliver a batch again when it
 * retried it. The SDK's interface has no Result: a store that can't be reached rejects, which the
 * SDK takes as the write or the read failing.
 */

export type {SdkSessionStore};

// What the SDK is thrown where the store failed: what it was doing, with the failure as the cause.
function failed<T>(doing: string, result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(`The session store could not ${doing}: ${result.error.kind}`, {cause: result.error});
	}
	return result.value;
}

// A line as the SDK wrote it, from its JSON; null for one that isn't that, which no append of the
// SDK's could have written.
function parseEntry(line: string): SessionStoreEntry | null {
	const parsed = Result.wrap((): unknown => JSON.parse(line));
	if (parsed.isErr()) {
		return null;
	}
	const value = jsonValueSchema.safeParse(parsed.value);
	if (!value.success || !isRecord(value.data) || typeof value.data.type !== 'string') {
		return null;
	}
	const {uuid, ...rest} = value.data;
	if (uuid !== undefined && typeof uuid !== 'string') {
		return null;
	}
	return {...rest, type: value.data.type, ...(uuid === undefined ? {} : {uuid})};
}

/** The SDK's session store on the transcripts the store keeps. */
export function sdkSessionStore(store: TranscriptStore): SdkSessionStore {
	return {
		append: async (key, entries) => {
			failed(
				'append to the transcript',
				await store.appendTranscript(
					key,
					entries.map((entry) => ({...(entry.uuid === undefined ? {} : {uuid: entry.uuid}), entry: JSON.stringify(entry)})),
				),
			);
		},
		load: async (key) => {
			const lines = failed('read the transcript', await store.loadTranscript(key));
			if (lines === null) {
				return null;
			}
			return lines.flatMap((line) => {
				const entry = parseEntry(line);
				return entry === null ? [] : [entry];
			});
		},
		listSubkeys: async (key) => failed('list the session’s files', await store.listTranscriptSubkeys({projectKey: key.projectKey, sessionId: key.sessionId})),
		delete: async (key) => {
			failed('delete the transcript', await store.deleteTranscript(key));
		},
	};
}
