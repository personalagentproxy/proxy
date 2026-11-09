import type {JsonValue} from '@proxy/utils/harness';

/**
 * The Claude Agent SDK's session store, as the SDK takes one: where it writes its transcripts
 * when it is given a store instead of its files, so that a thread's session can be resumed from
 * any api instance. The SDK hands over batches of transcript lines, each a JSON object with a
 * `type` and mostly a `uuid`, under a key of its own, the project (from the working directory it
 * was given), the session, and a subpath for a sub-agent's or a sidecar file; it reads them back
 * in order to resume, lists a session's subpaths, and deletes a session. These types mirror the
 * SDK's `SessionStore`, `SessionKey` and `SessionStoreEntry`, so that the SDK takes a store of
 * this shape as it is, structurally, and the api, which keeps the store on its database
 * (api/src/harness/session-store.ts), need not depend on the SDK package; they must stay that
 * shape. The SDK's interface has no Result: a store that can't be reached rejects, which the SDK
 * takes as the write or the read failing.
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

// A transcript's place in the memory store.
function pathOf(key: SessionKey): string {
	return `${key.projectKey}/${key.sessionId}/${key.subpath ?? ''}`;
}

/** A session store in memory, for the harness's tests and its smoke script: it keeps what it is given for as long as the process runs. */
export function memorySessionStore(): SdkSessionStore {
	const transcripts = new Map<string, SessionStoreEntry[]>();
	return {
		append: async (key, entries) => {
			transcripts.set(pathOf(key), [...(transcripts.get(pathOf(key)) ?? []), ...entries]);
		},
		load: async (key) => transcripts.get(pathOf(key)) ?? null,
		listSubkeys: async (key) => {
			const prefix = pathOf({projectKey: key.projectKey, sessionId: key.sessionId});
			return [...transcripts.keys()].flatMap((path) => (path.startsWith(prefix) && path !== prefix ? [path.slice(prefix.length)] : []));
		},
		delete: async (key) => {
			transcripts.delete(pathOf(key));
		},
	};
}
