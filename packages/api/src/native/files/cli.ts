import type {Response} from 'express';
import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {FILES_INTEGRATION_ID, type Integration, TOOLS_COLLECTION_ID} from '@proxy/integrations';
import {CLI_FILE_HEADER, CLI_STATUS, type CliFile, type cliFileListSchema, cliListQuerySchema, cliPullQuerySchema, type cliPushedSchema, cliPushQuerySchema} from '@proxy/contracts/cli';
import type {AgentRow} from '@proxy/db/agent';
import {logAgentRequest} from '@proxy/db/audit';
import type {ConnectionRow} from '@proxy/db/connection';
import {createFile, ensureFolder, type FileChangeBy, type FileEntry, findPath, getFileVersion, listFolder, writeFile} from '@proxy/db/files';

import {actionRefusal, actionsOf, agentViewer, failureOf, type Outcome, recordToolCall, requireAgent, type TaskCaller} from '../../agent-side/tools';
import {unavailableActions} from '../../connections/unavailable';
import {log as serverLog, serializeError} from '../../observability/log';
import {loadConnection} from '../../records/target';
import {agentErrorMessage} from '../../script/agent-host';
import type {CliRequest} from '../../server/middleware/require-cli';
import {readsAttached} from './attached';
import {requireFile} from './connector';
import {maxFileBytes, openContent, sendContent, storeContent, uploadBody} from './content';
import {fileLink} from './links';
import {mediaType, requireFileName} from './names';
import {pathOf} from './text';

/**
 * A drive's files by path, for code in a sandbox (@proxy/contracts/cli, `pap files`): listing a
 * folder, a file's bytes down, and a file's bytes up. What a tool can't do, its answer being
 * text, done the way a tool's run is: as the token's agent, for the token's task, checked against
 * what the agent may do with the drive as it is now, and written in the activity log as the read,
 * the new file or the write it is, coming in as `cli`; a change is in the drive's journal as the
 * agent's, for that task. A file written over is written by whoever names the version it holds,
 * as the write tool has it, unless the push says to write over whatever is there. A file the
 * person attached to the conversation is read at that version whatever the agent may do in the
 * drive otherwise, as the read tool reads it (attached.ts).
 */

type Gate = {
	caller: TaskCaller;
	agent: AgentRow;
	connection: ConnectionRow & {credential: string | null};
	integration: Integration;
	actions: string[];
	change: FileChangeBy;
	startedAt: number;
};

// What the activity log keeps of a request: the collection and the action it is logged as, as a
// tool's run of the same would be, the folder listed, and the params as that tool takes them.
type Entry = {collection: string; action: string; title?: string | null; query?: string | null};

// The drive the address names, as the token's agent reaches it now.
function open(request: CliRequest): Promise<Result<Gate, ApiError>> {
	return Do(async ($) => {
		const startedAt = Date.now();
		const caller: TaskCaller = {agent: request.cli.agent, via: 'cli', taskId: request.cli.taskId};
		const connectionId = request.params.connectionId ?? '';
		const [agentRead, connectionRead] = await Promise.all([requireAgent(caller.agent), loadConnection(agentViewer(caller.agent), connectionId)]);
		const agent = $(agentRead);
		const {connection, integration} = $(connectionRead);
		if (integration.id !== FILES_INTEGRATION_ID) {
			return $(Err(ApiErr.validationError(`${connectionId} is not a drive: pap files works on a Files connection (pap connections lists yours).`)));
		}
		const actions = actionsOf(agent, connection, integration, unavailableActions(connection));
		const change: FileChangeBy = {orgId: connection.orgId, connectionId: connection.id, by: {agentId: caller.agent.agentId, taskId: caller.taskId}};
		return {caller, agent, connection, integration, actions, change, startedAt};
	});
}

function logged(gate: Gate, entry: Entry, outcome: Outcome, error?: string): Promise<Result<void, ApiError>> {
	recordToolCall(gate.caller, gate.connection, entry.action, outcome, gate.startedAt, error);
	return logAgentRequest({
		orgId: gate.caller.agent.orgId,
		agentId: gate.caller.agent.agentId,
		connectionId: gate.connection.id,
		collectionId: entry.collection,
		action: entry.action,
		recordTitle: entry.title ?? null,
		query: entry.query ?? null,
		outcome,
		via: 'cli',
		taskId: gate.caller.taskId,
		ownerUserId: gate.caller.agent.ownerUserId,
		startedAt: gate.startedAt,
		error,
	});
}

/**
 * Does `work` where the agent has `action`, or `allowed` says the person allowed this very thing,
 * and logs how it went: refused, as denied; failed, with what went wrong; or done.
 */
function gated<T>(gate: Gate, action: string, entry: Entry, allowed: boolean, work: () => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		if (!gate.actions.includes(action) && !allowed) {
			$(await logged(gate, entry, 'denied'));
			return $(Err(actionRefusal(gate.integration, gate.agent, gate.connection, unavailableActions(gate.connection), action)));
		}
		const done = await work();
		if (done.isErr()) {
			$(await logged(gate, entry, 'failed', failureOf(done.error)));
			return $(done);
		}
		$(await logged(gate, entry, 'allowed'));
		return done.value;
	});
}

// A path as its names, from the drive's top: none for the top.
function namesOf(path: string): Result<string[], ApiError> {
	const names: string[] = [];
	for (const part of path.split('/')) {
		if (part.trim() === '') {
			continue;
		}
		const name = requireFileName(part);
		if (name.isErr()) {
			return Err(name.error);
		}
		names.push(name.value);
	}
	return Ok(names);
}

function toCliFile(entry: FileEntry, path: string): CliFile {
	return {id: entry.id, name: entry.name, path, folder: entry.folder, version: entry.head?.id ?? null, size: entry.head?.size ?? null, type: entry.head?.type ?? null};
}

type Listed = z.infer<typeof cliFileListSchema>;
type Pulled = {said: CliFile; body: ReadableStream<Uint8Array>};
type Pushed = z.infer<typeof cliPushedSchema>;

// What went wrong, as the CLI's call route says it: 422, the kind of error and what to do.
function fail(response: Response, error: ApiError): void {
	if (error.kind === 'internal_error' || error.kind === 'db_error') {
		serverLog.error('A pap files request failed', {kind: error.kind, ...serializeError(error.cause)});
	}
	const message = 'message' in error && error.message ? error.message : agentErrorMessage(error, 'cli');
	response.status(CLI_STATUS.failed).json({error: error.kind, message});
}

/** `GET /api/cli/files/:connectionId/list?path=`: what a folder holds, by its path. */
export async function handleCliListFilesRoute(request: CliRequest, response: Response): Promise<void> {
	const listed = await Do<Listed, ApiError>(async ($) => {
		const gate = $(await open(request));
		const {path} = $(parseSchema(cliListQuerySchema, request.query));
		const names = $(namesOf(path));
		const at = names.join('/');
		return $(
			await gated(gate, 'readFiles', {collection: 'files', action: 'list', title: names.at(-1) ?? null}, false, () =>
				Do<Listed, ApiError>(async ($$) => {
					const {found, missing} = $$(await findPath(gate.connection.id, names));
					const folder = found.at(-1) ?? null;
					if (missing.length > 0) {
						return $$(Err(ApiErr.notFound('folder', at, `There is no ${at} in this drive.`)));
					}
					if (folder !== null && !folder.folder) {
						return $$(Err(ApiErr.validationError(`${at} is a file: pap files pull reads it.`)));
					}
					const entries = $$(await listFolder(gate.connection.id, folder?.id ?? null));
					return {path: at, files: entries.map((entry) => toCliFile(entry, at === '' ? entry.name : `${at}/${entry.name}`))};
				}),
			),
		);
	});
	if (listed.isErr()) {
		fail(response, listed.error);
		return;
	}
	response.status(CLI_STATUS.ok).json(listed.value);
}

/** `GET /api/cli/files/:connectionId/content?path=|id=&version=`: a file's bytes, with which file they are in a header. */
export async function handleCliPullFileRoute(request: CliRequest, response: Response): Promise<void> {
	const pulled = await Do<Pulled, ApiError>(async ($) => {
		const gate = $(await open(request));
		const {path, id, version: asked} = $(parseSchema(cliPullQuerySchema, request.query));
		const names = path === undefined ? [] : $(namesOf(path));
		// Found before the gate, by its path: the log says which file was read, by its id.
		const byPath = path === undefined ? null : $(await findPath(gate.connection.id, names));
		if (byPath !== null && (byPath.missing.length > 0 || byPath.found.length === 0)) {
			return $(Err(ApiErr.notFound('file', names.join('/'), `There is no ${names.join('/')} in this drive.`)));
		}
		const fileId = id ?? byPath?.found.at(-1)?.id ?? '';
		const params = {id: fileId, ...(asked === undefined ? {} : {version: asked})};
		const attached = $(await readsAttached({caller: gate.caller, connection: gate.connection, params}));
		return $(
			await gated(gate, 'readFiles', {collection: TOOLS_COLLECTION_ID, action: 'files_read', query: JSON.stringify(params)}, attached, () =>
				Do<Pulled, ApiError>(async ($$) => {
					const file = $$(await requireFile(gate.connection.id, fileId));
					if (file.folder) {
						return $$(Err(ApiErr.validationError(`${file.name} is a folder: pap files ls lists it.`)));
					}
					const versionId = $$(requirePresent(asked ?? file.head?.id, ApiErr.notFound('file', fileId)));
					const version = $$(requirePresent($$(await getFileVersion(gate.connection.id, file.id, versionId)), ApiErr.notFound('version', versionId, `${file.name} has no version ${versionId}.`)));
					const said: CliFile = {id: file.id, name: file.name, path: pathOf(file), folder: false, version: version.id, size: version.size, type: version.type};
					return {said, body: $$(await openContent(version.blob))};
				}),
			),
		);
	});
	if (pulled.isErr()) {
		fail(response, pulled.error);
		return;
	}
	const {said, body} = pulled.value;
	response.status(CLI_STATUS.ok);
	response.setHeader('Content-Type', 'application/octet-stream');
	response.setHeader('Content-Length', String(said.size ?? 0));
	response.setHeader(CLI_FILE_HEADER, encodeURIComponent(JSON.stringify(said)));
	const sent = await sendContent(response, body);
	if (sent.isErr()) {
		serverLog.warn('A file pulled into a sandbox failed partway', {fileId: said.id, ...serializeError(sent.error)});
	}
}

/** `PUT /api/cli/files/:connectionId/content?path=&version=&force=`: a new file at the path, or the next version of the one there. */
export async function handleCliPushFileRoute(request: CliRequest, response: Response): Promise<void> {
	const pushed = await Do<Pushed, ApiError>(async ($) => {
		const gate = $(await open(request));
		const {path, version, force} = $(parseSchema(cliPushQuerySchema, request.query));
		const names = $(namesOf(path));
		const at = names.join('/');
		const name = $(requirePresent(names.at(-1), ApiErr.validationError('Give the path to push to, as Reports/q3.csv.')));
		const {found, missing} = $(await findPath(gate.connection.id, names));
		const there = found.at(-1) ?? null;

		// A file is there: its next version, by whoever names the one it holds, or says to write over it.
		if (missing.length === 0 && there !== null) {
			if (there.folder) {
				return $(Err(ApiErr.validationError(`${at} is a folder: give the file’s path inside it, or end the path with a slash, as ${at}/, to keep the file’s own name.`)));
			}
			const held = there.head?.id ?? '';
			const ifVersion = force === '1' ? held : version;
			const entry = {collection: TOOLS_COLLECTION_ID, action: 'files_write', query: JSON.stringify({id: there.id, version: ifVersion ?? null})};
			return $(
				await gated(gate, 'editFiles', entry, false, () =>
					Do<Pushed, ApiError>(async ($$) => {
						if (ifVersion !== held) {
							const why = ifVersion === undefined ? `${at} is there already` : `${at} changed since it was pulled`;
							return $$(
								Err(
									ApiErr.conflict(`${why}: it holds version ${held} now. Pull it again and push what you make of that, or push with --force to write over it; the version before is kept either way.`),
								),
							);
						}
						const stored = $$(await storeContent(gate.connection.orgId, $$(uploadBody(request)), maxFileBytes()));
						const written = $$(await writeFile(gate.change, {fileId: there.id, ifVersion: held, content: {blobId: stored.blobId, size: stored.size, type: mediaType(there.name, undefined, 'bytes')}}));
						return {file: toCliFile(written, at), created: false, link: fileLink(gate.caller.agent.orgSlug, gate.connection.id, written)};
					}),
				),
			);
		}

		// Nothing is there: a new file, in the folders of its path, made where they are missing.
		if (there !== null && !there.folder) {
			return $(Err(ApiErr.validationError(`${found.map((one) => one.name).join('/')} is a file, so nothing goes inside it.`)));
		}
		const entry = {collection: TOOLS_COLLECTION_ID, action: 'files_create', query: JSON.stringify({path: at})};
		return $(
			await gated(gate, 'createFiles', entry, false, () =>
				Do<Pushed, ApiError>(async ($$) => {
					const stored = $$(await storeContent(gate.connection.orgId, $$(uploadBody(request)), maxFileBytes()));
					let parentId = there?.id ?? null;
					for (const folder of missing.slice(0, -1)) {
						parentId = $$(await ensureFolder(gate.change, {parentId, name: folder})).id;
					}
					const made = $$(await createFile(gate.change, {parentId, name, content: {blobId: stored.blobId, size: stored.size, type: mediaType(name, undefined, 'bytes')}}));
					return {file: toCliFile(made, at), created: true, link: fileLink(gate.caller.agent.orgSlug, gate.connection.id, made)};
				}),
			),
		);
	});
	if (pushed.isErr()) {
		fail(response, pushed.error);
		return;
	}
	response.status(CLI_STATUS.ok).json(pushed.value);
}
