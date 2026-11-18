import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';
import {getFileUpload} from '@proxy/db/file-uploads';

import type {NativeToolAction, NativeToolRunner} from '../native/tool';
import {type DeclaredFile, type DriveUploads, finishUpload, startUpload, type UploadDone, type UploadTarget, type UploadTicket} from './tickets';

/**
 * `files_upload` and `files_upload_done`, the same on every drive that takes uploads (tickets.ts),
 * each drive's module naming them with its own `DriveUploads`. An answer is a few lines a model
 * reads: the upload's id, the URL with how to send the bytes to it, and a line of `curl` it can
 * run as it is, since an agent with a shell but no `pap` has that; then the file done made, as the
 * other writes answer. A new file needs Add files and one written over Edit files, as the gate
 * asks of each run (`uploadActions`).
 */

const CREATE_ACTION = 'createFiles';
const EDIT_ACTION = 'editFiles';

const SHA256 = /^[0-9a-fA-F]{64}$/;

const uploadSchema = z.object({
	name: z.string().optional(),
	parent: z.string().min(1).optional(),
	id: z.string().min(1).optional(),
	version: z.string().min(1).optional(),
	size: z.number().int().nonnegative(),
	type: z.string().min(1).optional(),
	sha256: z.string().regex(SHA256, 'a SHA-256 is 64 hex digits').optional(),
	convert: z.boolean().optional(),
});

const TAKES = 'size, with name (and parent) for a new file or id and version to write over one, and type, sha256 and convert where wanted';

type UploadAsked = {target: UploadTarget; file: DeclaredFile};

// What an upload makes, and what it is to be, from the tool's params.
function readUpload(params: Record<string, unknown>): Result<UploadAsked, ApiError> {
	return Do<UploadAsked, ApiError>(($): UploadAsked => {
		const parsed = $(parseSchema(uploadSchema, params).mapErr((error) => ApiErr.validationError(`files_upload takes ${TAKES}${error.kind === 'parse_error' ? `: ${error.message}` : ''}`)));
		const file = {size: parsed.size, sha256: parsed.sha256?.toLowerCase() ?? null, type: parsed.type ?? null};
		if (parsed.id !== undefined) {
			if (parsed.name !== undefined || parsed.parent !== undefined) {
				return $(Err(ApiErr.validationError('files_upload writes over the file id names, where it is: leave name and parent out, or id to add a new file')));
			}
			if (parsed.version === undefined) {
				return $(Err(ApiErr.validationError('To write over a file, give the version you read too')));
			}
			if (parsed.convert === true) {
				return $(Err(ApiErr.validationError('convert makes a new file into a Doc, Sheet or Slides file; a file written over keeps its own kind: leave convert out')));
			}
			return {target: {kind: 'write', fileId: parsed.id, version: parsed.version}, file};
		}
		if (parsed.name === undefined) {
			return $(Err(ApiErr.validationError('files_upload takes the new file’s name, or the id of a file to write over')));
		}
		return {target: {kind: 'create', parentId: parsed.parent ?? null, folders: [], name: parsed.name, convert: parsed.convert ?? false}, file};
	});
}

function ticketText(ticket: UploadTicket): string {
	const {put} = ticket;
	const headers = Object.entries(put.headers).map(([name, value]) => `${name}: ${value}`);
	return [
		`Upload: ${ticket.upload}`,
		`URL: ${put.url}`,
		`Method: ${put.method}`,
		`Headers: ${headers.length === 0 ? 'none needed' : headers.join('; ')}`,
		`Expires: ${put.expiresAt.toISOString()}`,
		'',
		`Send ${ticket.name}’s ${ticket.size} bytes to the URL, from a shell, as:`,
		`curl -X PUT --upload-file <path> '${put.url}'`,
		...(put.resumable ? ['It takes the file in parts too, each with its Content-Range, as a resumable upload.'] : []),
		'',
		`Then call files_upload_done with upload ${ticket.upload}, which checks what arrived and finishes the file${ticket.target === 'write' ? '’s next version' : ''}. The URL takes one upload, until it expires.`,
	].join('\n');
}

function doneText(done: UploadDone): string {
	const said = done.created ? `Added ${done.name}.` : `Wrote ${done.name}. The version before is kept.`;
	return [said, `Id: ${done.made.fileId}`, `Version: ${done.made.version}`, `Size: ${formatBytes(done.size)}`, `Link: ${done.link}`].join('\n');
}

const doneSchema = z.object({upload: z.string().min(1)});

function readDone(params: Record<string, unknown>): Result<string, ApiError> {
	return parseSchema(doneSchema, params)
		.map(({upload}) => upload)
		.mapErr(() => ApiErr.validationError('files_upload_done takes upload, the id files_upload answered with'));
}

/** The two tools' runners for a drive that takes uploads as `uploads` has it. */
export function uploadTools(uploads: DriveUploads): {files_upload: NativeToolRunner; files_upload_done: NativeToolRunner} {
	return {
		files_upload: (run) =>
			Do(async ($) => {
				const {target, file} = $(readUpload(run.params));
				return ticketText($(await startUpload(run, uploads, target, file)));
			}),
		files_upload_done: (run) =>
			Do(async ($) => {
				return doneText($(await finishUpload(run, uploads, $(readDone(run.params)))));
			}),
	};
}

/**
 * What a run of either tool needs, for the gate: Edit files to write over a file, and to finish an
 * upload that does; Add files for a new file. An upload done can't find is asked of as a new
 * file's, and then not found by the tool.
 */
export const uploadActions: {files_upload: NativeToolAction; files_upload_done: NativeToolAction} = {
	files_upload: (run) => Promise.resolve(Ok(typeof run.params.id === 'string' && run.params.id !== '' ? EDIT_ACTION : CREATE_ACTION)),
	files_upload_done: (run) =>
		Do(async ($) => {
			const id = readDone(run.params);
			if (id.isErr()) {
				return CREATE_ACTION;
			}
			const upload = $(await getFileUpload(run.connection.id, id.value));
			return upload?.target === 'write' ? EDIT_ACTION : CREATE_ACTION;
		}),
};
