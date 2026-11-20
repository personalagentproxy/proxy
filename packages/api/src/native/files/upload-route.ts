import type {Request, Response} from 'express';
import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, apiErrorMessage, Do, requirePresent} from '@proxy/utils';
import type {UploadReceived, UploadRefused} from '@proxy/contracts/uploads';
import {getFileBlob} from '@proxy/db/files';
import {findFileUploadBySecret, unlockFileUpload} from '@proxy/db/file-uploads';

import {log, serializeError} from '../../observability/log';
import {hashUploadSecret, holdingUpload, lockUpload} from '../../uploads/tickets';
import {fillBlob, requestBytes, type StoredContent} from './content';

/**
 * `PUT /api/uploads/:secret` (@proxy/contracts/uploads): the bytes of an upload into a drive, of
 * Files or Google Drive alike, at the URL files_upload answered with (uploads/tickets.ts). The
 * secret in the address is the one credential, so the route has no session, no token and no
 * origin check, and is open to any origin; it is known only by its hash, and neither it nor the address is ever logged (the
 * request logger writes the route's pattern). The body is read as it comes, whatever its type,
 * into the blob made for the upload at its start, counted and hashed as it passes; more bytes than
 * the upload said are refused as they come, and fewer once they have come. One PUT of the whole
 * file takes an upload; one that fails partway, or comes short, lets it go again, for another try,
 * until its hour is up.
 */

type Refusal = {status: number; body: UploadRefused};

function refused(status: number, error: string, message: string): Refusal {
	return {status, body: {error, message}};
}

const UNKNOWN_BLOB = ApiErr.notFound('blob', undefined, 'This upload’s place in the store is gone. Start again with files_upload.');

const UNKNOWN = refused(404, 'not_found', 'This URL takes no upload. files_upload gives a URL to upload a file to.');

// The api's error, as this route answers it; the server's own failures said plainly, and logged.
function fromApiError(error: ApiError): Refusal {
	if (error.statusCode >= 500) {
		log.error('An upload’s bytes could not be taken', {kind: error.kind, ...('cause' in error ? serializeError(error.cause) : {})});
		return refused(error.statusCode, error.kind, 'The upload failed on the server: send the file again.');
	}
	return refused(error.statusCode, error.kind, apiErrorMessage(error) ?? error.kind);
}

function receive(request: Request): Promise<Result<UploadReceived, Refusal>> {
	return Do(async ($) => {
		const secret = request.params.secret ?? '';
		const upload = $(requirePresent($((await findFileUploadBySecret(hashUploadSecret(secret))).mapErr(fromApiError)), UNKNOWN));
		const next = `Call files_upload_done with upload ${upload.id} to make the file.`;
		if (upload.status === 'expired' || (upload.status === 'open' && upload.receivedAt === null && upload.expiresAt <= new Date())) {
			return $(Err(refused(410, 'expired', 'This URL took bytes for an hour, and the hour is up. Start again with files_upload.')));
		}
		if (upload.status !== 'open') {
			return $(Err(refused(409, 'conflict', `Upload ${upload.id} is finished already: files_upload_done says how it ended.`)));
		}
		if (upload.receivedAt !== null) {
			return $(Err(refused(409, 'conflict', `The file for upload ${upload.id} arrived already, and a URL takes one. ${next}`)));
		}
		if (!$((await lockUpload(upload.id, true)).mapErr(fromApiError))) {
			return $(Err(refused(409, 'conflict', `The file for upload ${upload.id} is being sent to this URL already. Wait for that PUT to answer.`)));
		}
		const filled = await holdingUpload(upload.id, () =>
			Do<StoredContent, ApiError>(async ($$) => {
				const blob = $$(requirePresent($$(await getFileBlob(upload.blobId)), UNKNOWN_BLOB));
				const tooLarge = `More than the ${upload.size} bytes upload ${upload.id} was started for came. Send the file it was started for, or start again with files_upload and the file’s size in bytes.`;
				return $$(await fillBlob(blob, $$(requestBytes(request)), upload.size, tooLarge));
			}),
		);
		// Only the whole file takes the URL: one that came short lets it go again, for the file to be sent whole.
		const whole = filled.isOk() && filled.value.size === upload.size;
		const unlocked = await unlockFileUpload(upload.id, whole ? {received: new Date()} : {});
		if (filled.isErr()) {
			const {error} = filled;
			return $(Err(error.kind === 'validation_error' ? refused(413, 'too_large', error.message) : fromApiError(error)));
		}
		$(unlocked.mapErr(fromApiError));
		if (!whole) {
			return $(
				Err(
					refused(
						400,
						'incomplete',
						`${filled.value.size} of the ${upload.size} bytes upload ${upload.id} was started for came, so they were not kept. Send the whole file to this URL again, or start again with files_upload and the file’s size in bytes, as wc -c < <path> counts it.`,
					),
				),
			);
		}
		return {upload: upload.id, size: filled.value.size, sha256: filled.value.sha256, next};
	});
}

/** `PUT /api/uploads/:secret`: an upload's bytes, answered with what arrived. */
export async function handleUploadBytesRoute(request: Request, response: Response): Promise<void> {
	const received = await receive(request);
	if (received.isErr()) {
		// What is left of a body nobody read is read and dropped, so the answer reaches whoever sends it.
		request.resume();
		response.status(received.error.status).json(received.error.body);
		return;
	}
	response.status(200).json(received.value);
}
