import type {Response} from 'express';
import {Err, Ok, type Result} from 'ts-results-es';
import type {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {type ApiTool, FILES_INTEGRATION_ID, findTool, TOOLS_COLLECTION_ID} from '@proxy/integrations';
import {CLI_FILE_HEADER, CLI_STATUS, type CliFile, type cliFileListSchema, cliListQuerySchema, cliPullQuerySchema, type cliPushedSchema, cliPushQuerySchema} from '@proxy/contracts/cli';
import {createFile, ensureFolder, type FileChangeBy, type FileEntry, findPath, getFileVersion, listFolder, writeFile} from '@proxy/db/files';

import {gateRun, loadRunTarget, type RunTarget, type TaskCaller} from '../../agent-side/tools';
import {log as serverLog, serializeError} from '../../observability/log';
import {agentErrorMessage} from '../../script/agent-host';
import type {CliRequest} from '../../server/middleware/require-cli';
import {requireReadFile} from './attached';
import {maxFileBytes, openContent, sendContent, storeContent, uploadBody} from './content';
import {fileLink} from './links';
import {mediaType, requireFileName} from './names';
import {pathOf} from './text';

/**
 * A drive's files by path, for code in a sandbox (@proxy/contracts/cli, `pap files`): listing a
 * folder, a file's bytes down, and a file's bytes up. What a tool can't do, its answer being
 * text, done through a tool's gate (agent-side/tools.ts gateRun): as the token's agent, for the
 * token's task, checked against what the agent may do with the drive as it is now, and written in
 * the activity log as the read, the new file or the write it is, coming in as `cli`; a change is in the drive's journal as the
 * agent's, for that task. A file written over is written by whoever names the version it holds,
 * as the write tool has it, unless the push says to write over whatever is there. A file the
 * person attached to the conversation is read at that version whatever the agent may do in the
 * drive otherwise, as the read tool reads it (attached.ts).
 */

// A drive as the token's agent reaches it now, and who a change to it is made by.
type Drive = RunTarget & {change: FileChangeBy};

// The drive the address names, as the token's agent reaches it now.
function open(request: CliRequest): Promise<Result<Drive, ApiError>> {
	return Do(async ($) => {
		const caller: TaskCaller = {agent: request.cli.agent, via: 'cli', taskId: request.cli.taskId};
		const connectionId = request.params.connectionId ?? '';
		const target = $(await loadRunTarget(caller, connectionId));
		if (target.integration.id !== FILES_INTEGRATION_ID) {
			return $(Err(ApiErr.validationError(`${connectionId} is not a drive: pap files works on a Files connection (pap connections lists yours).`)));
		}
		const change: FileChangeBy = {orgId: target.connection.orgId, connectionId: target.connection.id, by: {agentId: caller.agent.agentId, taskId: caller.taskId}};
		return {...target, change};
	});
}

// The drive's tool a request does what it does as, which it is checked and logged as (agent-side/tools.ts gateRun).
function toolOf(drive: Drive, name: string): Result<ApiTool, ApiError> {
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
		// A file the person attached to the conversation is read whatever the agent may do in the drive otherwise (attached.ts).
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

/** `PUT /api/cli/files/:connectionId/content?path=&version=&force=`: a new file at the path, or the next version of the one there. */
export async function handleCliPushFileRoute(request: CliRequest, response: Response): Promise<void> {
	const pushed = await Do<Pushed, ApiError>(async ($) => {
		const drive = $(await open(request));
		const {path, version, force} = $(parseSchema(cliPushQuerySchema, request.query));
		const names = $(namesOf(path));
		const at = names.join('/');
		const name = $(requirePresent(names.at(-1), ApiErr.validationError('Give the path to push to, as Reports/q3.csv.')));
		const {found, missing} = $(await findPath(drive.connection.id, names));
		const there = found.at(-1) ?? null;

		// A file is there: its next version, by whoever names the one it holds, or says to write over it.
		// What is in the way is said only past the gate, so an agent that may not change the drive
		// can't tell what its paths are.
		if (missing.length === 0 && there !== null) {
			const held = there.head?.id ?? '';
			const ifVersion = force === '1' ? held : version;
			const params = {id: there.id, version: ifVersion ?? null};
			const entry = {collection: TOOLS_COLLECTION_ID, action: 'files_write', title: null, query: JSON.stringify(params)};
			return $(
				await gateRun(drive, $(toolOf(drive, 'files_write')), params, entry, () =>
					Do<Pushed, ApiError>(async ($$) => {
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
						const stored = $$(await storeContent(drive.connection.orgId, $$(uploadBody(request)), maxFileBytes()));
						const written = $$(
							await writeFile(drive.change, {fileId: there.id, ifVersion: held, content: {blobId: stored.blobId, size: stored.size, type: mediaType(there.name, undefined, 'bytes')}}),
						);
						return {file: toCliFile(written, at), created: false, link: fileLink(drive.caller.agent.orgSlug, drive.connection.id, written)};
					}),
				),
			);
		}

		// Nothing is there: a new file, in the folders of its path, made where they are missing.
		const params = {path: at};
		const entry = {collection: TOOLS_COLLECTION_ID, action: 'files_create', title: null, query: JSON.stringify(params)};
		return $(
			await gateRun(drive, $(toolOf(drive, 'files_create')), params, entry, () =>
				Do<Pushed, ApiError>(async ($$) => {
					if (there !== null && !there.folder) {
						return $$(Err(ApiErr.validationError(`${found.map((one) => one.name).join('/')} is a file, so nothing goes inside it.`)));
					}
					const stored = $$(await storeContent(drive.connection.orgId, $$(uploadBody(request)), maxFileBytes()));
					let parentId = there?.id ?? null;
					for (const folder of missing.slice(0, -1)) {
						parentId = $$(await ensureFolder(drive.change, {parentId, name: folder})).id;
					}
					const made = $$(await createFile(drive.change, {parentId, name, content: {blobId: stored.blobId, size: stored.size, type: mediaType(name, undefined, 'bytes')}}));
					return {file: toCliFile(made, at), created: true, link: fileLink(drive.caller.agent.orgSlug, drive.connection.id, made)};
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
