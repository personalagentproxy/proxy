import type {Response} from 'express';
import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {type ApiTool, FILES_INTEGRATION_ID, findTool, TOOLS_COLLECTION_ID} from '@proxy/integrations';
import {
	CLI_FILE_HEADER,
	CLI_STATUS,
	type CliFile,
	type cliFileListSchema,
	cliListQuerySchema,
	cliPullQuerySchema,
	type cliPushedSchema,
	cliUploadQuerySchema,
	type CliUploadStarted,
} from '@proxy/contracts/cli';
import {type FileEntry, findPath, getFileVersion, listFolder} from '@proxy/db/files';

import {actionsOf, gateRun, loadRunTarget, type RunTarget, type TaskCaller} from '../../agent-side/tools';
import {apiIntegration} from '../../connections/integrations';
import {unavailableActions} from '../../connections/unavailable';
import {log as serverLog, serializeError} from '../../observability/log';
import {agentErrorMessage} from '../../script/agent-host';
import type {CliRequest} from '../../server/middleware/require-cli';
import {type DeclaredFile, type DriveUploads, finishUpload, startUpload, type UploadRun, type UploadTicket} from '../../uploads/tickets';
import {requireReadFile} from './attached';
import {requireFile} from './connector';
import {openContent, sendContent} from './content';
import {requireFileName} from './names';
import {pathOf} from './text';

/**
 * A drive's files by path, for code in a sandbox (@proxy/contracts/cli, `pap files`): listing a
 * folder, a file's bytes down, and a file's bytes up. What a tool can't do, its answer being
 * text, done through a tool's gate (agent-side/tools.ts gateRun): as the token's agent, for the
 * token's task, checked against what the agent may do with the drive as it is now, and written in
 * the activity log as the read or the upload it is, coming in as `cli`. A push is an upload, as
 * files_upload and files_upload_done make one (uploads/tickets.ts): started by path, checked
 * before any bytes are sent, the bytes sent to the URL it is answered with, and the file made at
 * done, as the agent's, for that task, in the drive's journal. A file written over is written by
 * whoever names the version it holds, as the write tool has it, unless the push says to write over
 * what is there. A file the person attached in the thread is read at that version whatever the
 * agent may do in the drive otherwise, as the read tool reads it (attached.ts).
 */

// Reading a drive, which tells an agent what is in it.
const READ_ACTION = 'readFiles';

// The drive the address names, as the token's agent reaches it now.
function open(request: CliRequest): Promise<Result<RunTarget, ApiError>> {
	return Do(async ($) => {
		const caller: TaskCaller = {agent: request.cli.agent, via: 'cli', taskId: request.cli.taskId};
		const connectionId = request.params.connectionId ?? '';
		const target = $(await loadRunTarget(caller, connectionId));
		if (target.integration.id !== FILES_INTEGRATION_ID) {
			return $(Err(ApiErr.validationError(`${connectionId} is not a drive: pap files works on a Files connection (pap connections lists yours).`)));
		}
		return target;
	});
}

// The drive's tool a request does what it does as, which it is checked and logged as (agent-side/tools.ts gateRun).
function toolOf(drive: RunTarget, name: string): Result<ApiTool, ApiError> {
	const tool = findTool(drive.integration, name);
	if (tool?.kind !== 'native') {
		return Err(ApiErr.notFound('tool', name));
	}
	return Ok(tool);
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
		const drive = $(await open(request));
		const {path} = $(parseSchema(cliListQuerySchema, request.query));
		const names = $(namesOf(path));
		const at = names.join('/');
		const entry = {collection: 'files', action: 'list', title: names.at(-1) ?? null, query: null};
		return $(
			await gateRun(drive, $(toolOf(drive, 'files_read')), {path: at}, entry, () =>
				Do<Listed, ApiError>(async ($$) => {
					const {found, missing} = $$(await findPath(drive.connection.id, names));
					const folder = found.at(-1) ?? null;
					if (missing.length > 0) {
						return $$(Err(ApiErr.notFound('folder', at, `There is no ${at} in this drive.`)));
					}
					if (folder !== null && !folder.folder) {
						return $$(Err(ApiErr.validationError(`${at} is a file: pap files pull reads it.`)));
					}
					const entries = $$(await listFolder(drive.connection.id, folder?.id ?? null));
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
		const drive = $(await open(request));
		const {path, id, version: asked} = $(parseSchema(cliPullQuerySchema, request.query));
		const names = path === undefined ? [] : $(namesOf(path));
		// Found before the gate, by its path: the log says which file was read, by its id. Whether
		// there is one is said only past the gate, so an agent that may not read the drive can't
		// tell which paths are in it.
		const byPath = path === undefined ? null : $(await findPath(drive.connection.id, names));
		const absent = byPath !== null && (byPath.missing.length > 0 || byPath.found.length === 0);
		const fileId = id ?? (absent ? undefined : byPath?.found.at(-1)?.id) ?? '';
		const params = {id: fileId, ...(asked === undefined ? {} : {version: asked})};
		// A file the person attached in the thread is read whatever the agent may do in the drive otherwise (attached.ts).
		const entry = {collection: TOOLS_COLLECTION_ID, action: 'files_read', title: null, query: JSON.stringify(params)};
		return $(
			await gateRun(drive, $(toolOf(drive, 'files_read')), params, entry, () =>
				Do<Pulled, ApiError>(async ($$) => {
					if (absent) {
						return $$(Err(ApiErr.notFound('file', names.join('/'), `There is no ${names.join('/')} in this drive.`)));
					}
					const file = $$(await requireReadFile(drive.caller, drive.connection.id, fileId, asked));
					if (file.folder) {
						return $$(Err(ApiErr.validationError(`${file.name} is a folder: pap files ls lists it.`)));
					}
					const versionId = $$(requirePresent(asked ?? file.head?.id, ApiErr.notFound('file', fileId)));
					const version = $$(requirePresent($$(await getFileVersion(drive.connection.id, file.id, versionId)), ApiErr.notFound('version', versionId, `${file.name} has no version ${versionId}.`)));
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

// The drive's uploads (uploads/tickets.ts), which a push goes through as files_upload does.
function uploadsOf(drive: RunTarget): Result<DriveUploads, ApiError> {
	const uploads = apiIntegration(drive.integration.id)?.uploads;
	if (uploads === undefined) {
		return Err(ApiErr.validationError(`${drive.connection.id} takes no uploads: pap files push works on a Files connection.`));
	}
	return Ok(uploads);
}

// An upload started, as the CLI answers it.
function startedOf(ticket: UploadTicket): CliUploadStarted {
	return {upload: ticket.upload, put: {...ticket.put, expiresAt: ticket.put.expiresAt.toISOString()}};
}

/**
 * `POST /api/cli/files/:connectionId/uploads?path=&size=&sha256=&version=&force=`: an upload of a
 * new file to the path, or of the next version of the one there, checked as files_upload checks it
 * and logged as one, before any bytes are sent; answered with where to send them.
 */
export async function handleCliStartUploadRoute(request: CliRequest, response: Response): Promise<void> {
	const started = await Do<CliUploadStarted, ApiError>(async ($) => {
		const drive = $(await open(request));
		const uploads = $(uploadsOf(drive));
		const {path, size, sha256, version, force} = $(parseSchema(cliUploadQuerySchema, request.query));
		const names = $(namesOf(path));
		const at = names.join('/');
		const name = $(requirePresent(names.at(-1), ApiErr.validationError('Give the path to push to, as Reports/q3.csv.')));
		const {found, missing} = $(await findPath(drive.connection.id, names));
		const there = missing.length === 0 ? (found.at(-1) ?? null) : null;
		const file: DeclaredFile = {size, sha256, type: null};
		const tool = $(toolOf(drive, 'files_upload'));
		const runOf = (entryId: string): UploadRun => ({caller: drive.caller, connection: drive.connection, entryId});

		// A write over what is there, or a new file: chosen by what is in the drive only for an agent
		// that may read it, which knows what its paths are anyway. One that may not may change
		// nothing in it either (adding and writing need reading), and is refused as a new file
		// whatever is there, so which it was refused as tells it nothing. What is in the way is said
		// only past the gate.
		const actions = actionsOf(drive.agent, drive.connection, drive.integration, unavailableActions(drive.connection));
		const writes = actions.includes(READ_ACTION) && there !== null;

		// The file there: its next version, by whoever names the one it holds, or says to write over it.
		if (writes) {
			const held = there?.head?.id ?? '';
			const ifVersion = force === '1' ? held : version;
			const params = {id: there?.id ?? '', path: at, version: ifVersion ?? null, size};
			const entry = {collection: TOOLS_COLLECTION_ID, action: 'files_upload', title: null, query: JSON.stringify(params)};
			return $(
				await gateRun(drive, tool, params, entry, (entryId) =>
					Do<CliUploadStarted, ApiError>(async ($$) => {
						if (there === null) {
							return $$(Err(ApiErr.notFound('file', at, `There is no ${at} in this drive.`)));
						}
						if (there.folder) {
							return $$(Err(ApiErr.validationError(`${at} is a folder: give the file’s path inside it, or end the path with a slash, as ${at}/, to keep the file’s own name.`)));
						}
						if (ifVersion !== held) {
							const why = ifVersion === undefined ? `${at} is there already` : `${at} changed since it was pulled`;
							return $$(
								Err(
									ApiErr.conflict(`${why}: it holds version ${held} now. Pull it again and push what you make of that, or push with --force to write over it; the version before is kept either way.`),
								),
							);
						}
						return startedOf($$(await startUpload(runOf(entryId), uploads, {kind: 'write', fileId: there.id, version: held}, file)));
					}),
				),
			);
		}

		// A new file, in the folders of its path, made at done where they are missing.
		const params = {path: at, size};
		const entry = {collection: TOOLS_COLLECTION_ID, action: 'files_upload', title: null, query: JSON.stringify(params)};
		return $(
			await gateRun(drive, tool, params, entry, (entryId) =>
				Do<CliUploadStarted, ApiError>(async ($$) => {
					// The deepest of the path that is there, short of the new file itself.
					const reached = there === null ? found : found.slice(0, -1);
					const inside = reached.at(-1) ?? null;
					if (inside !== null && !inside.folder) {
						return $$(Err(ApiErr.validationError(`${reached.map((one) => one.name).join('/')} is a file, so nothing goes inside it.`)));
					}
					const target = {kind: 'create' as const, parentId: inside?.id ?? null, folders: missing.slice(0, -1), name};
					return startedOf($$(await startUpload(runOf(entryId), uploads, target, file)));
				}),
			),
		);
	});
	if (started.isErr()) {
		fail(response, started.error);
		return;
	}
	response.status(CLI_STATUS.ok).json(started.value);
}

/**
 * `POST /api/cli/files/:connectionId/uploads/:upload/done`: the file of an upload's bytes, once
 * they arrived and are what was said, made as files_upload_done makes it and logged as one.
 */
export async function handleCliFinishUploadRoute(request: CliRequest, response: Response): Promise<void> {
	const pushed = await Do<Pushed, ApiError>(async ($) => {
		const drive = $(await open(request));
		const uploads = $(uploadsOf(drive));
		const params = {upload: request.params.upload ?? ''};
		const entry = {collection: TOOLS_COLLECTION_ID, action: 'files_upload_done', title: null, query: JSON.stringify(params)};
		return $(
			await gateRun(drive, $(toolOf(drive, 'files_upload_done')), params, entry, (entryId) =>
				Do<Pushed, ApiError>(async ($$) => {
					const done = $$(await finishUpload({caller: drive.caller, connection: drive.connection, entryId}, uploads, params.upload));
					const {fileId, version: versionId} = done.made;
					const made = $$(await requireFile(drive.connection.id, fileId));
					const version = $$(requirePresent($$(await getFileVersion(drive.connection.id, fileId, versionId)), ApiErr.notFound('version', versionId)));
					const file: CliFile = {id: made.id, name: made.name, path: pathOf(made), folder: false, version: version.id, size: version.size, type: version.type};
					return {file, created: done.created, link: done.link};
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
