import {Err, Ok} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';
import {checkNewFile, createFile, createFileBlob, type FileChangeBy, getFile, getFileBlob, writeFile} from '@proxy/db/files';
import type {FileUploadRow} from '@proxy/db/file-uploads';

import type {DriveUploads} from '../../uploads/tickets';
import {requireFile} from './connector';
import {maxFileBytes, newBlobKey, requireBlobs} from './content';
import {fileLink} from './links';
import {mediaType, requireFileName} from './names';

/**
 * Uploads into a drive of Files (uploads/tickets.ts): the bytes go to a blob of the store here,
 * made at the start, through Personal Agent Proxy's own URL (upload-route.ts), which counts and
 * hashes them as they pass. Everything a write checks is checked at the start too, so a URL is
 * only handed out for a file that could be made: the folder, the name free in it, or the version
 * of the file written over; and the size, against the largest file the server takes. The file is
 * made at done, as the upload's agent's, for its task, and checked again then, as the drive may
 * have changed in the hour. A blob of an upload never finished is no version's, and so is taken by
 * the sweep of unused blobs (sweeper.ts).
 */

function changeOf(upload: FileUploadRow): FileChangeBy {
	return {orgId: upload.orgId, connectionId: upload.connectionId, by: {agentId: upload.agentId, taskId: upload.taskId}};
}

export const filesUploads: DriveUploads = {
	start: (run, target, file) =>
		Do(async ($) => {
			const connectionId = run.connection.id;
			if (file.size > maxFileBytes()) {
				return $(Err(ApiErr.validationError(`A file is at most ${formatBytes(maxFileBytes())} on this server, ${maxFileBytes()} bytes, and this one is ${file.size}.`)));
			}
			const backend = $(await requireBlobs());
			const named = await Do<{name: string; fileId: string | null}, ApiError>(async ($$) => {
				if (target.kind === 'create') {
					const name = $$(requireFileName(target.name));
					$$(await checkNewFile(connectionId, {parentId: target.parentId, name}));
					return {name, fileId: null};
				}
				const found = $$(await requireFile(connectionId, target.fileId));
				if (found.folder) {
					return $$(Err(ApiErr.validationError(`${found.name} is a folder, which holds no bytes: give a file’s id, or a name and this folder as parent to add a file in it`)));
				}
				if (found.head?.id !== target.version) {
					return $$(
						Err(ApiErr.conflict(`${found.name} changed since that version was read: it holds ${found.head?.id ?? 'nothing'} now. Read it again with files_read, then upload what you make of it.`)),
					);
				}
				return {name: found.name, fileId: found.id};
			});
			const {name, fileId} = $(named);
			const blob = $(await createFileBlob({orgId: run.connection.orgId, backendId: backend.id, key: newBlobKey(run.connection.orgId)}));
			return {name, type: mediaType(name, file.type ?? undefined, 'bytes'), fileId, to: {kind: 'blob' as const, blobId: blob.id}};
		}),

	arrived: (_run, upload) =>
		Do(async ($) => {
			if (upload.receivedAt === null || upload.blobId === null) {
				return null;
			}
			const blob = $(requirePresent($(await getFileBlob(upload.blobId)), ApiErr.notFound('blob', upload.blobId)));
			return {size: blob.size, sha256: blob.sha256};
		}),

	finish: (_run, upload, arrived) =>
		Do(async ($) => {
			const broken = (what: string) => ApiErr.internalError(new Error(`Upload ${upload.id} to Files has no ${what}.`));
			const content = {blobId: $(requirePresent(upload.blobId, broken('blob'))), size: arrived.size, type: upload.type};
			const entry =
				upload.target === 'create'
					? $(await createFile(changeOf(upload), {parentId: upload.parentId, name: upload.name, content}))
					: $(await writeFile(changeOf(upload), {fileId: $(requirePresent(upload.fileId, broken('file'))), ifVersion: $(requirePresent(upload.version, broken('version'))), content}));
			return {fileId: entry.id, version: $(requirePresent(entry.head, broken('version made'))).id};
		}),

	link: (run, upload, made) =>
		Do(async ($) => {
			const file = $(await getFile(upload.connectionId, made.fileId));
			return fileLink(run.caller.agent.orgSlug, upload.connectionId, file ?? {id: made.fileId, parentId: upload.parentId, folder: false});
		}),

	// Nothing to let go of here: the blob is left to the sweep of unused blobs.
	expire: () => Promise.resolve(Ok(undefined)),
};
