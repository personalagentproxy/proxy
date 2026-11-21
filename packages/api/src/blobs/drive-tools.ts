import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';
import {CLI_EXPORTS} from '@proxy/contracts/cli';

import {readParams, type NativeToolAction, type NativeToolRunner} from '../native/tool';
import type {Drive, DriveAt, UploadTarget} from '../native/files/drive';
import {blobLines, ownerOf, requireBlob, storeBlob} from './blobs';

/**
 * `files_blob` and `files_upload`, the same on every drive (native/files/drive.ts): a file's bytes
 * made a blob, and a blob put in the drive, as a new file or a file's next version. Each answer is
 * a few lines a model reads, with what the next call needs: the blob's id, or the file's id, the
 * version it holds and its link. A new file needs Add files and one written over Edit files, as the
 * gate asks of each run (`uploadAction`).
 */

const blobSchema = z.object({
	id: z.string().min(1),
	version: z.string().min(1).optional(),
	as: z.enum(CLI_EXPORTS).optional(),
	tab: z.string().min(1).max(200).optional(),
});

const uploadSchema = z.object({
	blob: z.string().min(1),
	name: z.string().min(1).optional(),
	parent: z.string().min(1).optional(),
	id: z.string().min(1).optional(),
	version: z.string().min(1).optional(),
	convert: z.boolean().optional(),
});

type UploadParams = z.infer<typeof uploadSchema>;

// Where a blob goes, from the tool's params: over the file `id` names, else a new file, called what
// `name` says or what the blob is called.
function targetOf(params: UploadParams, blobName: string | null): Result<UploadTarget, ApiError> {
	if (params.id !== undefined) {
		if (params.name !== undefined || params.parent !== undefined) {
			return Err(ApiErr.validationError('files_upload writes over the file id names, where it is: leave name and parent out, or id to add a new file'));
		}
		if (params.version === undefined) {
			return Err(ApiErr.validationError('To write over a file, give the version you read too'));
		}
		if (params.convert === true) {
			return Err(ApiErr.validationError('convert makes a new file into a Doc, Sheet or Slides file; a file written over keeps its own kind: leave convert out'));
		}
		return Ok({kind: 'write', fileId: params.id, version: params.version});
	}
	const name = params.name ?? blobName;
	if (name === null) {
		return Err(ApiErr.validationError('This blob has no name of its own: give the new file’s name, with its extension, as report.pdf'));
	}
	return Ok({kind: 'create', parentId: params.parent ?? null, folders: [], name, convert: params.convert ?? false});
}

/** The two tools' runners, for a drive of the kind `driveOf` reaches. */
export function driveTools(driveOf: (at: DriveAt) => Drive): {files_blob: NativeToolRunner; files_upload: NativeToolRunner} {
	return {
		files_blob: (run) =>
			Do(async ($) => {
				const {id, version, as, tab} = $(readParams(blobSchema, 'files_blob', 'id, and version, as and tab where wanted', run.params));
				const {said, body} = $(await driveOf(run).pull({id, version: version ?? null, as: as ?? null, tab: tab ?? null, path: null}));
				const blob = $(await storeBlob(ownerOf(run.caller.agent), {name: said.name, type: said.type}, body));
				const exported = said.format === null ? '' : `, as ${said.format}`;
				return [`Made a blob of ${said.name}, version ${said.version}${exported}.`, ...blobLines(blob)].join('\n');
			}),

		files_upload: (run) =>
			Do(async ($) => {
				const params = $(readParams(uploadSchema, 'files_upload', 'blob, with name (and parent) for a new file or id and version to write over one, and convert where wanted', run.params));
				const blob = $(await requireBlob(ownerOf(run.caller.agent), params.blob));
				const target = $(targetOf(params, blob.name));
				const made = $(await driveOf(run).upload(target, blob));
				const said = target.kind === 'create' ? `Added ${made.name}.` : `Wrote ${made.name}. The version before is kept.`;
				return [said, `Id: ${made.fileId}`, `Version: ${made.version}`, `Size: ${formatBytes(blob.size)}`, `Link: ${made.link}`].join('\n');
			}),
	};
}

/** What a run of files_upload needs, for the gate: Edit files to write over a file, Add files for a new one. */
export const uploadAction: NativeToolAction = (run) => Promise.resolve(Ok(typeof run.params.id === 'string' && run.params.id !== '' ? 'editFiles' : 'createFiles'));
