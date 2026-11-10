import {Ok, type Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * The Claude Agent SDK's session transcripts (AgentHarnessTranscript), kept here rather than in
 * the files the SDK would write, so that any api instance can resume a thread's session. The api's
 * session store adapter (harness/session-store.ts) is what the SDK calls; this is what it keeps:
 * lines of a transcript, as JSON, under the SDK's key, a project, a session and a subpath, empty
 * for the session's own transcript and a sub-agent's or sidecar file's otherwise. Lines are read
 * back in the order they were appended. A line with a uuid is kept once per key, whatever the SDK
 * delivers twice, as it may a batch it retried. The transcript is the model's memory, not the
 * api's record of the thread: that is the thread's log (harness.ts).
 */

/** Where a transcript is: the SDK's project, by its working directory, its session, and the file within it, empty for the transcript itself. */
export type TranscriptKey = {projectKey: string; sessionId: string; subpath?: string};

/** A line to append: its JSON, and the uuid the SDK gave it, where the line has one, for keeping it once. */
export type TranscriptLine = {uuid?: string; entry: string};

// The key as the rows have it.
function whereKey(key: TranscriptKey): {projectKey: string; sessionId: string; subpath: string} {
	return {projectKey: key.projectKey, sessionId: key.sessionId, subpath: key.subpath ?? ''};
}

/**
 * Appends lines to the transcript at `key`, in order, skipping any whose uuid the transcript has
 * already, or that an earlier line of the batch had.
 */
export async function appendTranscript(
	key: TranscriptKey,
	lines: TranscriptLine[],
): Promise<Result<void, ApiError>> {
	if (lines.length === 0) {
		return Ok(undefined);
	}
	const where = whereKey(key);
	return (
		await wrapDb(() =>
			db.$transaction(async (tx) => {
				const uuids = lines.flatMap((line) => (line.uuid === undefined ? [] : [line.uuid]));
				const known = new Set(
					(
						await tx.agentHarnessTranscript.findMany({
							where: {...where, entryUuid: {in: uuids}},
							select: {entryUuid: true},
						})
					).flatMap((row) => (row.entryUuid === null ? [] : [row.entryUuid])),
				);
				for (const line of lines) {
					if (line.uuid !== undefined && known.has(line.uuid)) {
						continue;
					}
					if (line.uuid !== undefined) {
						known.add(line.uuid);
					}
					await tx.agentHarnessTranscript.create({
						data: {...where, entryUuid: line.uuid ?? null, entry: line.entry},
						select: {id: true},
					});
				}
			}),
		)
	).map(() => undefined);
}

/** The transcript at `key`, its lines in order; `Ok(null)` where there is none. */
export async function loadTranscript(
	key: TranscriptKey,
): Promise<Result<string[] | null, ApiError>> {
	return (
		await wrapDb(() =>
			db.agentHarnessTranscript.findMany({
				where: whereKey(key),
				select: {entry: true},
				orderBy: {seq: 'asc'},
			}),
		)
	).map((rows) => (rows.length === 0 ? null : rows.map((row) => row.entry)));
}

/** The subpaths the session has transcripts under beside its own, each once, in order. */
export async function listTranscriptSubkeys(key: {
	projectKey: string;
	sessionId: string;
}): Promise<Result<string[], ApiError>> {
	return (
		await wrapDb(() =>
			db.agentHarnessTranscript.findMany({
				where: {projectKey: key.projectKey, sessionId: key.sessionId, subpath: {not: ''}},
				select: {subpath: true},
				distinct: ['subpath'],
				orderBy: {subpath: 'asc'},
			}),
		)
	).map((rows) => rows.map((row) => row.subpath));
}

/**
 * Deletes the transcript at `key`: the session's own, given with no subpath, with every transcript
 * under the session, or the one at the subpath alone.
 */
export async function deleteTranscript(key: TranscriptKey): Promise<Result<void, ApiError>> {
	const subpath = key.subpath ?? '';
	return (
		await wrapDb(() =>
			db.agentHarnessTranscript.deleteMany({
				where: {
					projectKey: key.projectKey,
					sessionId: key.sessionId,
					...(subpath === '' ? {} : {subpath}),
				},
			}),
		)
	).map(() => undefined);
}
