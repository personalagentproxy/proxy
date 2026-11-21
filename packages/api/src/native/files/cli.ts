import type {Response} from 'express';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, apiErrorMessage, Do, parseSchema, requirePresent} from '@proxy/utils';
import {findTool, type Tool, TOOLS_COLLECTION_ID} from '@proxy/integrations';
import {type CliFile, CLI_FILE_HEADER, CLI_STATUS, cliListQuerySchema, cliPullQuerySchema, cliPushCheckQuerySchema, cliPushQuerySchema, type CliPushed} from '@proxy/contracts/cli';

import {actionsOf, gateAsked, gateRun, loadRunTarget, type RunEntry, type RunTarget, type TaskCaller} from '../../agent-side/tools';
import {apiIntegration} from '../../connections/integrations';
import {unavailableActions} from '../../connections/unavailable';
import {log as serverLog, serializeError} from '../../observability/log';
import {agentErrorMessage} from '../../script/agent-host';
import type {CliRequest} from '../../server/middleware/require-cli';
import {ownerOf, requireBlob} from '../../blobs/blobs';
import {type Drive, type DriveListing, type FilePull, type UploadMade, type UploadTarget, versionToWrite, type WriteAsk} from './drive';
import {requireFileSize, sendContent} from './content';

/**
 * A drive's files by path, for code in a sandbox (@proxy/contracts/cli, `pap files`): listing a
 * folder, a file's bytes down, and a blob put in the drive by path, on a drive of Files or a Google
 * Drive, each reached through its `Drive` (drive.ts). What a tool can't do by path, done through a
 * tool's gate (agent-side/tools.ts gateRun): as the token's agent, for the token's task, checked
 * against what the agent may do with the drive as it is now, and written in the activity log as the
 * read or the files_upload it is, coming in as `cli`. A push is asked about first, so one that
 * would be refused is refused before its bytes move; then the file is sent to a blob, through the
 * URL pap.upload() answers with (blobs/), and the blob put in the drive here, as the agent's, for
 * that task, in the drive's history. A file written over is written by whoever names
 * the version it holds, as the write tool has it, unless the push says to write over what is
 * there. A file the person attached in the thread is read at that version whatever the agent may
 * do in the drive otherwise, as the read tool reads it (attached.ts).
 */

// Reading a drive, which tells an agent what is in it.
const READ_ACTION = 'readFiles';

type Opened = {target: RunTarget; drive: Drive};

// The drive the address names, as the token's agent reaches it now.
function open(request: CliRequest): Promise<Result<Opened, ApiError>> {
	return Do(async ($) => {
		const caller: TaskCaller = {agent: request.cli.agent, via: 'cli', taskId: request.cli.taskId};
		const connectionId = request.params.connectionId ?? '';
		const target = $(await loadRunTarget(caller, connectionId));
		const driveOf = apiIntegration(target.integration.id)?.drive;
		if (driveOf === undefined) {
			return $(Err(ApiErr.validationError(`${connectionId} is not a drive: pap files works on a Files or a Google connection (pap connections lists yours).`)));
		}
		return {target, drive: driveOf(target)};
	});
}

// The drive's tool a request does what it does as, which it is checked and logged as (agent-side/tools.ts gateRun).
function toolOf(target: RunTarget, name: string): Result<Tool, ApiError> {
	const tool = findTool(target.integration, name);
	if (tool === undefined || tool.kind === 'call') {
		return Err(ApiErr.notFound('tool', name));
	}
	return Ok(tool);
}

// A run of a tool as the activity log keeps it: one of the drive's own by its name, with its
// params; a collection's by its collection and what it does, as a run of it is logged.
function entryOf(tool: Tool, params: Record<string, unknown>): RunEntry {
	const query = JSON.stringify(params);
	if (tool.kind === 'native' || tool.kind === 'call') {
		return {collection: TOOLS_COLLECTION_ID, action: tool.name, title: null, query};
	}
	return {collection: tool.collectionId, action: tool.operation, title: null, query};
}

// What went wrong, as the CLI's call route says it: 422, the kind of error and what to do.
function fail(response: Response, error: ApiError): void {
	if (error.kind === 'internal_error' || error.kind === 'db_error') {
		serverLog.error('A pap files request failed', {kind: error.kind, ...serializeError(error.cause)});
	}
	const message = apiErrorMessage(error) ?? agentErrorMessage(error, 'cli');
	response.status(CLI_STATUS.failed).json({error: error.kind, message});
}

/** `GET /api/cli/files/:connectionId/list?path=`: what a folder holds, by its path. */
export async function handleCliListFilesRoute(request: CliRequest, response: Response): Promise<void> {
	const listed = await Do<DriveListing, ApiError>(async ($) => {
		const {target, drive} = $(await open(request));
		const {path} = $(parseSchema(cliListQuerySchema, request.query));
		const names = $(drive.namesOf(path));
		const entry = {collection: 'files', action: 'list', title: names.at(-1) ?? null, query: null};
		return $(await gateRun(target, $(toolOf(target, drive.reads.list)), {path: names.join('/')}, entry, () => drive.list(names)));
	});
	if (listed.isErr()) {
		fail(response, listed.error);
		return;
	}
	response.status(CLI_STATUS.ok).json(listed.value);
}

/**
 * `GET /api/cli/files/:connectionId/content?path=|id=&version=&as=&tab=`: a file's bytes, or a
 * Google Doc's, Sheet's or Slides file's export, with which file they are in a header.
 */
export async function handleCliPullFileRoute(request: CliRequest, response: Response): Promise<void> {
	const pulled = await Do<FilePull, ApiError>(async ($) => {
		const {target, drive} = $(await open(request));
		const {path, id, version, as, tab} = $(parseSchema(cliPullQuerySchema, request.query));
		const names = path === undefined ? [] : $(drive.namesOf(path));
		const at = names.join('/');
		// Found before the gate, by its path: the log says which file was read, by its id. Whether
		// there is one is said only past the gate, so an agent that may not read the drive can't
		// tell which paths are in it.
		const byPath = path === undefined ? null : await drive.resolve(names);
		const found = byPath?.isOk() && byPath.value.missing.length === 0 ? (byPath.value.found.at(-1) ?? null) : null;
		const fileId = id ?? found?.id ?? '';
		const params = {id: fileId, ...(version === undefined ? {} : {version}), ...(as === undefined ? {} : {as}), ...(tab === undefined ? {} : {tab})};
		// A file the person attached in the thread is read whatever the agent may do in the drive otherwise (attached.ts).
		const tool = $(toolOf(target, drive.reads.pull));
		return $(
			await gateRun(target, tool, params, entryOf(tool, params), () =>
				Do<FilePull, ApiError>(async ($$) => {
					if (byPath !== null) {
						$$(byPath);
						if (found === null) {
							return $$(Err(ApiErr.notFound('file', at, `There is no ${at} in this drive.`)));
						}
						if (found.folder) {
							return $$(Err(ApiErr.validationError(`${found.name} is a folder: pap files ls lists it.`)));
						}
					}
					// The path a file pulled by its id is at, noted with it; a file the drive can't find
					// by itself, as an attached version in the trash, is read as the pull finds it.
					const where = found?.path ?? (await drive.file(fileId)).map((file) => file.path).unwrapOr(null);
					return $$(await drive.pull({id: fileId, version: version ?? null, as: as ?? null, tab: tab ?? null, path: where}));
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
	// An export's size is known only once Drive has made it.
	if (said.size !== null) {
		response.setHeader('Content-Length', String(said.size));
	}
	response.setHeader(CLI_FILE_HEADER, encodeURIComponent(JSON.stringify(said)));
	const sent = await sendContent(response, body);
	if (sent.isErr()) {
		serverLog.warn('A file pulled into a sandbox failed partway', {fileId: said.id, ...serializeError(sent.error)});
	}
}

// The file a blob was put in, as the CLI answers it: read back with its path, or, where it can't
// be read just now, as the push made it at the path it went to, so a push that was made is never
// answered, or logged, as one that failed.
async function pushedOf(drive: Drive, created: boolean, made: UploadMade, path: string): Promise<CliPushed> {
	const read = await drive.file(made.fileId);
	const file: CliFile = read.unwrapOr({id: made.fileId, name: made.name, path, folder: false, version: made.version, size: null, type: null});
	return {file: {...file, version: made.version}, created, link: made.link};
}

// Where a push goes and how, as its address says it (@proxy/contracts/cli).
type PushWhere = {path?: string; id?: string; version?: string; force?: '1'; convert?: '1'};

/**
 * What a push comes to once it is known where it goes: the blob put there, through the gate; or,
 * asked about before its bytes are sent, only what the drive would refuse it for, through a gate
 * that logs what is refused and what fails and leaves the rest to the push that follows.
 */
type Put<T> = {
	// What the log's entry says is pushed: the blob, or the file's name and size.
	params: Record<string, unknown>;
	gate: typeof gateRun;
	// Done where the push goes, a file's place in the drive, at the path it has or is to have.
	at: (where: UploadTarget, path: string) => Promise<Result<T, ApiError>>;
};

// A push, to where its address says: a new file at the path, the folders on the way made where
// they are missing, or the next version of the file there, or of the file of the id.
function pushTo<T>({target, drive}: Opened, where: PushWhere, put: Put<T>): Promise<Result<T, ApiError>> {
	return Do<T, ApiError>(async ($) => {
		const ask: WriteAsk = {version: where.version ?? null, force: where.force === '1'};
		const convert = where.convert === '1';
		const tool = $(toolOf(target, 'files_upload'));
		const write = (there: CliFile): Promise<Result<T, ApiError>> =>
			Do(async ($$) => {
				if (convert) {
					return $$(Err(ApiErr.validationError(`--convert makes a new file, and ${there.path} is there already: push to a new path, or without --convert to write over it.`)));
				}
				return $$(await put.at({kind: 'write', fileId: there.id, version: $$(versionToWrite(there, ask))}, there.path));
			});

		// The file of the id: its next version, at the version named, as a push of a file pulled by its id.
		if (where.id !== undefined) {
			const named = await drive.file(where.id);
			const params = {...put.params, id: where.id, version: (ask.force ? named.map((file) => file.version).unwrapOr(null) : ask.version) ?? null};
			return $(
				await put.gate(target, tool, params, entryOf(tool, params), () =>
					Do<T, ApiError>(async ($$) => {
						const there = $$(named);
						if (there.folder) {
							return $$(Err(ApiErr.validationError(`${there.path} is a folder, which holds no bytes: push to a path inside it.`)));
						}
						return $$(await write(there));
					}),
				),
			);
		}

		const names = $(drive.pushNames($(drive.namesOf(where.path ?? '')), convert));
		const at = names.join('/');
		const name = $(requirePresent(names.at(-1), ApiErr.validationError('Give the path to push to, as Reports/q3.csv.')));
		// Found before the gate, and what went wrong finding it said only past it, as for a pull.
		const resolved = await drive.resolve(names);
		const {found, missing} = resolved.unwrapOr({found: [], missing: names});
		const there = resolved.isOk() && missing.length === 0 ? (found.at(-1) ?? null) : null;

		// A write over what is there, or a new file: chosen by what is in the drive only for an agent
		// that may read it, which knows what its paths are anyway. One that may not may change
		// nothing in it either (adding and writing need reading), and is refused as a new file
		// whatever is there, so which it was refused as tells it nothing. What is in the way is said
		// only past the gate.
		const actions = actionsOf(target.agent, target.connection, target.integration, unavailableActions(target.connection));
		const writes = actions.includes(READ_ACTION) && there !== null;

		// The file there: its next version, by whoever names the one it holds, or says to write over it.
		if (writes && there !== null) {
			const params = {...put.params, id: there.id, path: at, version: (ask.force ? there.version : ask.version) ?? null};
			return $(
				await put.gate(target, tool, params, entryOf(tool, params), () =>
					Do<T, ApiError>(async ($$) => {
						if (there.folder) {
							return $$(Err(ApiErr.validationError(`${at} is a folder: give the file’s path inside it, or end the path with a slash, as ${at}/, to keep the file’s own name.`)));
						}
						return $$(await write(there));
					}),
				),
			);
		}

		// A new file, in the folders of its path, made where they are missing.
		const params = {...put.params, path: at};
		return $(
			await put.gate(target, tool, params, entryOf(tool, params), () =>
				Do<T, ApiError>(async ($$) => {
					$$(resolved);
					// The deepest of the path that is there, short of the new file itself.
					const reached = there === null ? found : found.slice(0, -1);
					const inside = reached.at(-1) ?? null;
					if (inside !== null && !inside.folder) {
						return $$(Err(ApiErr.validationError(`${inside.path} is a file, so nothing goes inside it.`)));
					}
					return $$(await put.at({kind: 'create', parentId: inside?.id ?? null, folders: missing.slice(0, -1), name, convert}, at));
				}),
			),
		);
	});
}

/**
 * `POST /api/cli/files/:connectionId/push?blob=&path=|id=&version=&force=&convert=`: a blob of the
 * agent's put in the drive, as files_upload puts one, and logged as one: a new file at the path,
 * the folders on the way made where they are missing, or the next version of the file there, or of
 * the file of the id.
 */
export async function handleCliPushFileRoute(request: CliRequest, response: Response): Promise<void> {
	const pushed = await Do<CliPushed, ApiError>(async ($) => {
		const opened = $(await open(request));
		const {target, drive} = opened;
		const query = $(parseSchema(cliPushQuerySchema, request.query));
		return $(
			await pushTo(opened, query, {
				params: {blob: query.blob},
				gate: gateRun,
				at: (where, path) =>
					Do(async ($$) => {
						// The agent's blob, found past the gate, where what is wrong with it is said.
						const blob = $$(await requireBlob(ownerOf(target.caller.agent), query.blob));
						return await pushedOf(drive, where.kind === 'create', $$(await drive.upload(where, blob)), path);
					}),
			}),
		);
	});
	if (pushed.isErr()) {
		fail(response, pushed.error);
		return;
	}
	response.status(CLI_STATUS.ok).json(pushed.value);
}

/**
 * `POST /api/cli/files/:connectionId/push/check?file=&size=&path=|id=&version=&force=&convert=`:
 * a push asked about before the file is sent, so one that would be refused is refused before its
 * bytes move: the agent's access, where it goes, the version it names, its size, and what the
 * drive takes there of a file called that. Nothing is made, and only a refusal is logged, as the
 * files_upload it would have been.
 */
export async function handleCliCheckPushRoute(request: CliRequest, response: Response): Promise<void> {
	const checked = await Do<void, ApiError>(async ($) => {
		const opened = $(await open(request));
		const query = $(parseSchema(cliPushCheckQuerySchema, request.query));
		$(
			await pushTo(opened, query, {
				params: {file: query.file, size: query.size},
				gate: gateAsked,
				at: (where) =>
					Do(async ($$) => {
						$$(requireFileSize(query.size));
						// As the blob the file becomes would say it: its name, and no type of its own.
						$$(await opened.drive.check(where, {name: query.file, type: null}));
					}),
			}),
		);
	});
	if (checked.isErr()) {
		fail(response, checked.error);
		return;
	}
	response.status(CLI_STATUS.ok).json({});
}
