import type {Response} from 'express';
import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, apiErrorMessage, Do, parseSchema, requirePresent} from '@proxy/utils';
import {findTool, type Tool, TOOLS_COLLECTION_ID} from '@proxy/integrations';
import {CLI_FILE_HEADER, CLI_STATUS, cliListQuerySchema, cliPullQuerySchema, cliUploadQuerySchema, type CliUploadStarted} from '@proxy/contracts/cli';

import {actionsOf, gateRun, loadRunTarget, type RunEntry, type RunTarget, type TaskCaller} from '../../agent-side/tools';
import {apiIntegration} from '../../connections/integrations';
import {unavailableActions} from '../../connections/unavailable';
import {log as serverLog, serializeError} from '../../observability/log';
import {agentErrorMessage} from '../../script/agent-host';
import type {CliRequest} from '../../server/middleware/require-cli';
import type {UploadRun, UploadTicket} from '../../uploads/tickets';
import type {CliAsk, CliDrive, CliListed, CliPull, CliPush, CliPushed} from './cli-drive';
import {sendContent} from './content';

/**
 * A drive's files by path, for code in a sandbox (@proxy/contracts/cli, `pap files`): listing a
 * folder, a file's bytes down, and a file's bytes up, on a drive of Files or a Google Drive, each
 * reached through its `CliDrive` (cli-drive.ts). What a tool can't do, its answer being text, done
 * through a tool's gate (agent-side/tools.ts gateRun): as the token's agent, for the token's task,
 * checked against what the agent may do with the drive as it is now, and written in the activity
 * log as the read or the upload it is, coming in as `cli`. A push is an upload, as files_upload and
 * files_upload_done make one (uploads/tickets.ts): started by path, checked before any bytes are
 * sent, the bytes sent to the URL it is answered with, and the file made at done, as the agent's,
 * for that task, in the drive's history. A file written over is written by whoever names the
 * version it holds, as the write tool has it, unless the push says to write over what is there. A
 * file the person attached in the thread is read at that version whatever the agent may do in the
 * drive otherwise, as the read tool reads it (attached.ts).
 */

// Reading a drive, which tells an agent what is in it.
const READ_ACTION = 'readFiles';

type Opened = {drive: RunTarget; cli: CliDrive};

// The drive the address names, as the token's agent reaches it now.
function open(request: CliRequest): Promise<Result<Opened, ApiError>> {
	return Do(async ($) => {
		const caller: TaskCaller = {agent: request.cli.agent, via: 'cli', taskId: request.cli.taskId};
		const connectionId = request.params.connectionId ?? '';
		const drive = $(await loadRunTarget(caller, connectionId));
		const cliOf = apiIntegration(drive.integration.id)?.cli;
		if (cliOf === undefined) {
			return $(Err(ApiErr.validationError(`${connectionId} is not a drive: pap files works on a Files or a Google connection (pap connections lists yours).`)));
		}
		return {drive, cli: cliOf(drive)};
	});
}

// The drive's tool a request does what it does as, which it is checked and logged as (agent-side/tools.ts gateRun).
function toolOf(drive: RunTarget, name: string): Result<Tool, ApiError> {
	const tool = findTool(drive.integration, name);
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
	const listed = await Do<CliListed, ApiError>(async ($) => {
		const {drive, cli} = $(await open(request));
		const {path} = $(parseSchema(cliListQuerySchema, request.query));
		const names = $(cli.namesOf(path));
		const entry = {collection: 'files', action: 'list', title: names.at(-1) ?? null, query: null};
		return $(await gateRun(drive, $(toolOf(drive, cli.reads.list)), {path: names.join('/')}, entry, () => cli.list(names)));
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
	const pulled = await Do<CliPull, ApiError>(async ($) => {
		const {drive, cli} = $(await open(request));
		const {path, id, version, as, tab} = $(parseSchema(cliPullQuerySchema, request.query));
		const names = path === undefined ? [] : $(cli.namesOf(path));
		const at = names.join('/');
		// Found before the gate, by its path: the log says which file was read, by its id. Whether
		// there is one is said only past the gate, so an agent that may not read the drive can't
		// tell which paths are in it.
		const byPath = path === undefined ? null : await cli.resolve(names);
		const found = byPath?.isOk() && byPath.value.missing.length === 0 ? (byPath.value.found.at(-1) ?? null) : null;
		const fileId = id ?? found?.id ?? '';
		const params = {id: fileId, ...(version === undefined ? {} : {version}), ...(as === undefined ? {} : {as}), ...(tab === undefined ? {} : {tab})};
		// A file the person attached in the thread is read whatever the agent may do in the drive otherwise (attached.ts).
		const tool = $(toolOf(drive, cli.reads.pull));
		return $(
			await gateRun(drive, tool, params, entryOf(tool, params), () =>
				Do<CliPull, ApiError>(async ($$) => {
					if (byPath !== null) {
						$$(byPath);
						if (found === null) {
							return $$(Err(ApiErr.notFound('file', at, `There is no ${at} in this drive.`)));
						}
						if (found.folder) {
							return $$(Err(ApiErr.validationError(`${found.name} is a folder: pap files ls lists it.`)));
						}
					}
					return $$(await cli.pull({id: fileId, version: version ?? null, as: as ?? null, tab: tab ?? null, path: found?.path ?? null}));
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

// An upload started, as the CLI answers it.
function startedOf(ticket: UploadTicket): CliUploadStarted {
	return {upload: ticket.upload, put: {...ticket.put, expiresAt: ticket.put.expiresAt.toISOString()}};
}

/**
 * `POST /api/cli/files/:connectionId/uploads?path=|id=&size=&sha256=&version=&force=&file=&as=`: an
 * upload of a new file to the path, or of the next version of the one there, or of the file of the
 * id, checked as files_upload checks it and logged as one, before any bytes are sent; answered with
 * where to send them.
 */
export async function handleCliStartUploadRoute(request: CliRequest, response: Response): Promise<void> {
	const started = await Do<CliUploadStarted, ApiError>(async ($) => {
		const {drive, cli} = $(await open(request));
		const query = $(parseSchema(cliUploadQuerySchema, request.query));
		const push: CliPush = {size: query.size, sha256: query.sha256, file: query.file ?? null, as: query.as ?? null};
		const ask: CliAsk = {version: query.version ?? null, force: query.force === '1'};
		const tool = $(toolOf(drive, 'files_upload'));
		const runOf = (entryId: string): UploadRun => ({caller: drive.caller, connection: drive.connection, entryId});

		// The file of the id: its next version, at the version named, as a push of a file pulled by its id.
		if (query.id !== undefined) {
			const named = await cli.file(query.id);
			const params = {id: query.id, version: (ask.force ? named.map((file) => file.version).unwrapOr(null) : ask.version) ?? null, size: query.size};
			return $(
				await gateRun(drive, tool, params, entryOf(tool, params), (entryId) =>
					Do<CliUploadStarted, ApiError>(async ($$) => {
						const there = $$(named);
						if (there.folder) {
							return $$(Err(ApiErr.validationError(`${there.path} is a folder, which holds no bytes: push to a path inside it.`)));
						}
						return startedOf($$(await cli.startWrite(runOf(entryId), there, push, ask)));
					}),
				),
			);
		}

		const names = $(cli.pushNames($(cli.namesOf(query.path ?? '')), push.as));
		const at = names.join('/');
		const name = $(requirePresent(names.at(-1), ApiErr.validationError('Give the path to push to, as Reports/q3.csv.')));
		// Found before the gate, and what went wrong finding it said only past it, as for a pull.
		const resolved = await cli.resolve(names);
		const {found, missing} = resolved.unwrapOr({found: [], missing: names});
		const there = resolved.isOk() && missing.length === 0 ? (found.at(-1) ?? null) : null;

		// A write over what is there, or a new file: chosen by what is in the drive only for an agent
		// that may read it, which knows what its paths are anyway. One that may not may change
		// nothing in it either (adding and writing need reading), and is refused as a new file
		// whatever is there, so which it was refused as tells it nothing. What is in the way is said
		// only past the gate.
		const actions = actionsOf(drive.agent, drive.connection, drive.integration, unavailableActions(drive.connection));
		const writes = actions.includes(READ_ACTION) && there !== null;

		// The file there: its next version, by whoever names the one it holds, or says to write over it.
		if (writes && there !== null) {
			const params = {id: there.id, path: at, version: (ask.force ? there.version : ask.version) ?? null, size: query.size};
			return $(
				await gateRun(drive, tool, params, entryOf(tool, params), (entryId) =>
					Do<CliUploadStarted, ApiError>(async ($$) => {
						if (there.folder) {
							return $$(Err(ApiErr.validationError(`${at} is a folder: give the file’s path inside it, or end the path with a slash, as ${at}/, to keep the file’s own name.`)));
						}
						return startedOf($$(await cli.startWrite(runOf(entryId), there, push, ask)));
					}),
				),
			);
		}

		// A new file, in the folders of its path, made where they are missing.
		const params = {path: at, size: query.size};
		return $(
			await gateRun(drive, tool, params, entryOf(tool, params), (entryId) =>
				Do<CliUploadStarted, ApiError>(async ($$) => {
					$$(resolved);
					// The deepest of the path that is there, short of the new file itself.
					const reached = there === null ? found : found.slice(0, -1);
					const inside = reached.at(-1) ?? null;
					if (inside !== null && !inside.folder) {
						return $$(Err(ApiErr.validationError(`${inside.path} is a file, so nothing goes inside it.`)));
					}
					return startedOf($$(await cli.startCreate(runOf(entryId), {parent: inside, folders: missing.slice(0, -1), name}, push)));
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
	const pushed = await Do<CliPushed, ApiError>(async ($) => {
		const {drive, cli} = $(await open(request));
		const params = {upload: request.params.upload ?? ''};
		const tool = $(toolOf(drive, 'files_upload_done'));
		return $(await gateRun(drive, tool, params, entryOf(tool, params), (entryId) => cli.finish({caller: drive.caller, connection: drive.connection, entryId}, params.upload)));
	});
	if (pushed.isErr()) {
		fail(response, pushed.error);
		return;
	}
	response.status(CLI_STATUS.ok).json(pushed.value);
}
