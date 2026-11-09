import {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';
import {isRecord, type JsonValue, jsonValueSchema} from '@proxy/utils/harness';

import type {TranscriptStore} from './store';

/**
 * The Claude Agent SDK's session store, on the database: what the SDK writes its transcripts
 * through when it is given one instead of its files, so that a thread's session can be resumed
 * from any api instance. The SDK hands over batches of transcript lines, each a JSON object with a
 * `type` and mostly a `uuid`, under a key of its own, the project (from the working directory it
 * was given), the session, and a subpath for a sub-agent's or a sidecar file; it reads them back
 * in order to resume, lists a session's subpaths, and deletes a session. Each line is kept as it
 * was given, serialized; a line with a uuid is kept once, since the SDK may deliver a batch again
 * when it retried it. The types here mirror the SDK's `SessionStore`, `SessionKey` and
 * `SessionStoreEntry`, so that the SDK takes the store as it is, structurally, without the api
 * depending on the SDK package; they must stay that shape. The SDK's interface has no Result: a
 * store that can't be reached rejects, which the SDK takes as the write or the read failing.
 */

/** Where a transcript is, as the SDK keys it. */
export type SessionKey = {projectKey: string; sessionId: string; subpath?: string};

/** One line of a transcript, as the SDK writes it: a JSON object with its `type`, mostly a `uuid`, and the rest the SDK's. */
export type SessionStoreEntry = {type: string; uuid?: string} & Record<string, JsonValue>;

/** The SDK's session store, as the SDK takes it. */
export type SdkSessionStore = {
	append: (key: SessionKey, entries: SessionStoreEntry[]) => Promise<void>;
	load: (key: SessionKey) => Promise<SessionStoreEntry[] | null>;
	listSubkeys: (key: SessionKey) => Promise<string[]>;
	delete: (key: SessionKey) => Promise<void>;
};

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
