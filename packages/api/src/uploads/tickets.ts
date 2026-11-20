import {randomBytes} from 'node:crypto';

import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';
import {UPLOADS_PATH} from '@proxy/contracts/uploads';
import {createFileBlob, type FileBlobRow, getFileBlob} from '@proxy/db/files';
import {createFileUpload, expireFileUpload, failFileUpload, type FileUploadRow, finishFileUpload, getFileUpload, lockFileUpload, unlockFileUpload} from '@proxy/db/file-uploads';

import {hashToken} from '../auth/session';
import {blobBackend} from '../backends/backends';
import {maxFileBytes, newBlobKey} from '../native/files/content';
import type {NativeToolRun} from '../native/tool';
import {env} from '../utils/env';

/**
 * Uploads into a drive through a URL, for every kind of drive: a file too large for a tool's
 * params, sent as its bytes by whatever the agent has, a shell's `curl` as much as
 * `pap files push`. An upload is started by a call that checks everything about the file first,
 * the agent's access (the gate's, agent-side/tools.ts gateRun), the folder, the name, the size,
 * and is answered with a URL that takes the bytes for an hour; then `files_upload_done` checks what
 * arrived against what was said and makes the file, as the agent's, for the task that started it,
 * as every other write is made. Done is the only way an upload becomes a file, on every drive.
 *
 * The bytes always come here first: to a URL of Personal Agent Proxy's own, with a secret as its
 * one credential, of which only the hash is kept (native/files/upload-route.ts), into a blob of the
 * store made for the upload at its start. Nothing reaches the drive before done, so an upload never
 * finished, or whose bytes aren't what was said, leaves nothing behind but its blob, which the
 * sweep of unused blobs takes (native/files/sweeper.ts).
 *
 * What is the drive's own is a `DriveUploads`, in its integration's module: what the start checks,
 * making the file of the blob at done, and its link. What is the same for all is here: the
 * upload's row (@proxy/db/file-uploads), the blob, the URL's secret, the hour, and the order done
 * goes in.
 */

/** How long an upload's URL takes bytes. */
export const UPLOAD_TTL_MS = 60 * 60_000;

/** Who uploads, for which task and how the call came in; and the activity log's entry of the call. */
export type UploadRun = Pick<NativeToolRun, 'caller' | 'connection' | 'entryId'>;

/**
 * What an upload makes: a new file in a folder, the top where `parentId` is null, inside the
 * `folders` made in it on the way at done, where a push to a path names folders that are missing,
 * and `convert`ed into the drive's own kind of file where the drive has one, as Google Drive makes
 * a Doc of a docx; or the next version of a file, by whoever read `version`.
 */
export type UploadTarget = {kind: 'create'; parentId: string | null; folders: string[]; name: string; convert: boolean} | {kind: 'write'; fileId: string; version: string};

/** What the caller says it will send: how many bytes, their SHA-256 in hex where it says, and their media type where it says. */
export type DeclaredFile = {size: number; sha256: string | null; type: string | null};

/**
 * What a drive's checks at the start made of an upload: the file's name and media type, and the
 * file's id where it is known before done, as a file written over, or an id the drive reserves
 * for a new one.
 */
export type UploadStarted = {name: string; type: string; fileId: string | null};

/** The file an upload made, and the version of it that holds the bytes. */
export type UploadMade = {fileId: string; version: string};

/**
 * How a kind of drive takes uploads, in its integration's module (connections/integration.ts).
 * Each is answered with the api's error where it can't; one with `conflict`, `validation_error` or
 * `not_found` from `finish` is the upload refused for good, as a file that changed since the start,
 * and any other is an upload left open, to be finished again.
 */
export type DriveUploads = {
	/** Checks what the upload makes, against the drive as it is now. */
	start: (run: UploadRun, target: UploadTarget, file: DeclaredFile) => Promise<Result<UploadStarted, ApiError>>;
	/** Makes the file, or its next version, of the blob that arrived, as the upload's agent's, for its task. */
	finish: (run: UploadRun, upload: FileUploadRow, blob: FileBlobRow) => Promise<Result<UploadMade, ApiError>>;
	/** Where the person opens the file the upload made. */
	link: (run: UploadRun, upload: FileUploadRow, made: UploadMade) => Promise<Result<string, ApiError>>;
};

/** Where the bytes go: the URL, how to send them there, and until when. */
export type UploadPut = {url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: Date};

/** An upload started: its id, which done takes, the file's name and size as said, and where its bytes go. */
export type UploadTicket = {upload: string; name: string; size: number; target: UploadTarget['kind']; put: UploadPut};

/** An upload made into its file. */
export type UploadDone = {upload: string; name: string; size: number; created: boolean; made: UploadMade; link: string};

/** The URL Personal Agent Proxy serves for an upload's bytes, with its secret. */
function hostedUrl(secret: string): string {
	return `${env.APP_URL}${UPLOADS_PATH}/${secret}`;
}

/** How an upload's secret is kept: its hash, as sessions' tokens are, so the database never holds a URL that takes bytes. */
export function hashUploadSecret(secret: string): string {
	return hashToken(secret);
}

// The size said, against the largest file the server keeps in its store on the way to the drive.
function requireTakenSize(file: DeclaredFile): Result<void, ApiError> {
	if (file.size <= maxFileBytes()) {
		return Ok(undefined);
	}
	return Err(ApiErr.validationError(`A file is at most ${formatBytes(maxFileBytes())} on this server, ${maxFileBytes()} bytes, and this one is ${file.size}.`));
}

/** Starts an upload on the drive: checked by the drive, given a blob to fill, kept, and answered with where its bytes go. */
export function startUpload(run: UploadRun, uploads: DriveUploads, target: UploadTarget, file: DeclaredFile): Promise<Result<UploadTicket, ApiError>> {
	return Do(async ($) => {
		$(requireTakenSize(file));
		const backend = await blobBackend();
		const started = $(await uploads.start(run, target, file));
		const {caller, connection} = run;
		const blob = $(await createFileBlob({orgId: connection.orgId, backendId: backend.id, key: newBlobKey(connection.orgId)}));
		const secret = randomBytes(32).toString('base64url');
		const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
		const upload = $(
			await createFileUpload({
				orgId: connection.orgId,
				connectionId: connection.id,
				agentId: caller.agent.agentId,
				taskId: caller.taskId,
				via: caller.via,
				entryId: run.entryId ?? null,
				secretHash: hashUploadSecret(secret),
				target: target.kind,
				parentId: target.kind === 'create' ? target.parentId : null,
				name: started.name,
				folders: target.kind === 'create' ? target.folders : [],
				convert: target.kind === 'create' && target.convert,
				// The drive's own id of the file written over, where it reads one from a link.
				fileId: started.fileId ?? (target.kind === 'write' ? target.fileId : null),
				version: target.kind === 'write' ? target.version : null,
				size: file.size,
				sha256: file.sha256,
				type: started.type,
				blobId: blob.id,
				expiresAt,
			}),
		);
		return {upload: upload.id, name: upload.name, size: upload.size, target: upload.target, put: {url: hostedUrl(secret), method: 'PUT' as const, headers: {}, expiresAt}};
	});
}

const EXPIRED = 'This upload expired: its URL takes bytes for an hour, and nothing arrived in time. Start again with files_upload.';

// What finishing an open upload came to: the file made; refused for good, with why; or nothing to
// finish yet, with why, or past its hour.
type Settled = {kind: 'made'; made: UploadMade} | {kind: 'failed'; why: string} | {kind: 'waiting'; why: string} | {kind: 'expired'};

function errorText(error: ApiError): string {
	return 'message' in error && error.message ? error.message : error.kind;
}

// The blob the bytes arrived in, once a PUT has them all; none before.
function arrivedBlob(upload: FileUploadRow): Promise<Result<FileBlobRow | null, ApiError>> {
	return Do(async ($) => {
		if (upload.receivedAt === null) {
			return null;
		}
		return $(requirePresent($(await getFileBlob(upload.blobId)), ApiErr.notFound('blob', upload.blobId, 'This upload’s bytes are gone from the store. Start again with files_upload.')));
	});
}

// What arrived, checked against what was said, and made into the file.
function settle(run: UploadRun, uploads: DriveUploads, upload: FileUploadRow, now: Date): Promise<Result<Settled, ApiError>> {
	return Do(async ($): Promise<Settled> => {
		const blob = $(await arrivedBlob(upload));
		if (blob === null) {
			if (upload.expiresAt <= now) {
				return {kind: 'expired'};
			}
			return {
				kind: 'waiting',
				why: `Nothing has arrived for upload ${upload.id} yet: PUT the file to the URL files_upload answered with, as curl -X PUT --upload-file <path> '<url>', then call files_upload_done again.`,
			};
		}
		if (blob.size !== upload.size) {
			return {
				kind: 'failed',
				why: `${upload.name} was to be ${upload.size} bytes, and ${blob.size} arrived, so nothing was made of it. Start again with files_upload, with the file’s size in bytes, as wc -c < <path> counts it.`,
			};
		}
		if (upload.sha256 !== null && blob.sha256 !== upload.sha256) {
			return {
				kind: 'failed',
				why: `The bytes that arrived for ${upload.name} have the SHA-256 ${blob.sha256 ?? 'unknown'}, not the ${upload.sha256} given, so nothing was made of them. Start again with files_upload, and send the file whose hash you gave.`,
			};
		}
		const made = await uploads.finish(run, upload, blob);
		if (made.isErr() && (made.error.kind === 'conflict' || made.error.kind === 'validation_error' || made.error.kind === 'not_found')) {
			return {kind: 'failed', why: `${errorText(made.error)} Nothing was made of upload ${upload.id}: start again with files_upload.`};
		}
		return {kind: 'made', made: $(made)};
	});
}

function doneOf(run: UploadRun, uploads: DriveUploads, upload: FileUploadRow, made: UploadMade): Promise<Result<UploadDone, ApiError>> {
	return Do(async ($) => {
		const link = $(await uploads.link(run, upload, made));
		return {upload: upload.id, name: upload.name, size: upload.size, created: upload.target === 'create', made, link};
	});
}

// What done ends in for the upload's row, once it has the upload to work on: let go where it can't
// go on, and kept as it came out where it did.
function settled(upload: FileUploadRow, outcome: Result<Settled, ApiError>): Promise<Result<UploadMade, ApiError>> {
	return Do(async ($) => {
		if (outcome.isErr()) {
			$(await unlockFileUpload(upload.id));
			return $(outcome);
		}
		const {value} = outcome;
		if (value.kind === 'waiting') {
			$(await unlockFileUpload(upload.id));
			return $(Err(ApiErr.validationError(value.why)));
		}
		if (value.kind === 'expired') {
			$(await expireFileUpload(upload.id));
			return $(Err(ApiErr.conflict(EXPIRED)));
		}
		if (value.kind === 'failed') {
			$(await failFileUpload(upload.id, value.why));
			return $(Err(ApiErr.conflict(value.why)));
		}
		const finished = await finishFileUpload(upload.id, {fileId: value.made.fileId, afterVersion: value.made.version});
		if (finished.isErr()) {
			$(await unlockFileUpload(upload.id));
		}
		$(finished);
		return value.made;
	});
}

/**
 * Finishes one of the agent's uploads on the drive: what arrived checked against what was said,
 * and made into the file. Asked again, it answers as it did: the file made, or why it was refused.
 */
export function finishUpload(run: UploadRun, uploads: DriveUploads, uploadId: string): Promise<Result<UploadDone, ApiError>> {
	return Do(async ($) => {
		const missing = ApiErr.notFound('upload', uploadId, `There is no upload ${uploadId} of yours on this drive: files_upload starts one.`);
		const upload = $(requirePresent($(await getFileUpload(run.connection.id, uploadId)), missing));
		if (upload.agentId !== run.caller.agent.agentId) {
			return $(Err(missing));
		}
		if (upload.status === 'done' && upload.fileId !== null && upload.afterVersion !== null) {
			return $(await doneOf(run, uploads, upload, {fileId: upload.fileId, version: upload.afterVersion}));
		}
		if (upload.status === 'failed') {
			return $(Err(ApiErr.conflict(upload.failure ?? 'This upload was refused. Start again with files_upload.')));
		}
		if (upload.status === 'expired') {
			return $(Err(ApiErr.conflict(EXPIRED)));
		}

		const now = new Date();
		if (!$(await lockFileUpload(upload.id, {now, put: false}))) {
			return $(Err(ApiErr.conflict(`The file is still arriving for upload ${upload.id}, or being made: call files_upload_done again once the PUT has answered.`)));
		}
		const made = $(await settled(upload, await settle(run, uploads, upload, now)));
		return $(await doneOf(run, uploads, {...upload, fileId: made.fileId, afterVersion: made.version, status: 'done'}, made));
	});
}
