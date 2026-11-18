import {randomBytes} from 'node:crypto';

import {Err, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {UPLOADS_PATH} from '@proxy/contracts/uploads';
import {createFileUpload, expireFileUpload, failFileUpload, type FileUploadRow, finishFileUpload, getFileUpload, lockFileUpload, unlockFileUpload} from '@proxy/db/file-uploads';

import {hashToken} from '../auth/session';
import type {NativeToolRun} from '../native/tool';
import {log} from '../observability/log';
import {env} from '../utils/env';
import {encryptSecret} from '../utils/secret-crypto';

/**
 * Uploads into a drive through a URL, for every kind of drive: a file of any size, which a tool's
 * params can't carry, sent as its bytes by whatever the agent has, a shell's `curl` as much as
 * `pap files push`. An upload is started by a call that checks everything about the file first,
 * the agent's access (the gate's, agent-side/tools.ts gateRun), the folder, the name, the size,
 * and is answered with a URL that takes the bytes for an hour; then `files_upload_done` checks what
 * arrived against what was said and makes the file, as the agent's, for the task that started it,
 * as every other write is made. Done is the only way an upload becomes a file, on every drive.
 *
 * What is the drive's own is a `DriveUploads`, in its integration's module: what the start checks
 * and readies, where the bytes go, what arrived, and making the file. What is the same for all is
 * here: the upload's row (@proxy/db/file-uploads), the URL's secret, the hour, and the order done
 * goes in. A drive kept here takes the bytes at a URL of Personal Agent Proxy's own, with a secret
 * as its one credential, of which only the hash is kept (native/files/upload-route.ts); a drive
 * elsewhere, at its own, as Google Drive's resumable session, whose URL is kept encrypted.
 */

/** How long an upload's URL takes bytes. */
export const UPLOAD_TTL_MS = 60 * 60_000;

/** Who uploads, for which task and how the call came in; and the activity log's entry of the call. */
export type UploadRun = Pick<NativeToolRun, 'caller' | 'connection' | 'entryId'>;

/** What an upload makes: a new file in a folder, the top where `parentId` is null, or the next version of a file, by whoever read `version`. */
export type UploadTarget = {kind: 'create'; parentId: string | null; name: string} | {kind: 'write'; fileId: string; version: string};

/** What the caller says it will send: how many bytes, their SHA-256 in hex where it says, and their media type where it says. */
export type DeclaredFile = {size: number; sha256: string | null; type: string | null};

/**
 * What a drive readied for an upload: the file's name and media type, the file's id where it is
 * known before the bytes, and where they go: a blob of the store here, made for them, through
 * Personal Agent Proxy's own URL; or a URL of the drive's own, which may take them in parts.
 */
export type UploadStarted = {
	name: string;
	type: string;
	fileId: string | null;
	to: {kind: 'blob'; blobId: string} | {kind: 'session'; url: string; resumable: boolean};
};

/** What arrived of an upload: how many bytes, and their SHA-256 in hex where the drive says. */
export type UploadArrived = {size: number; sha256: string | null};

/** The file an upload made, and the version of it that holds the bytes. */
export type UploadMade = {fileId: string; version: string};

/**
 * How a kind of drive takes uploads, in its integration's module (connections/integration.ts).
 * Each is answered with the api's error where it can't; one with `conflict`, `validation_error` or
 * `not_found` from `finish` is the upload refused for good, as a file that changed since the start,
 * and any other is an upload left open, to be finished again.
 */
export type DriveUploads = {
	/** Checks what the upload makes, against the drive as it is now, and readies where its bytes go. */
	start: (run: UploadRun, target: UploadTarget, file: DeclaredFile) => Promise<Result<UploadStarted, ApiError>>;
	/** What arrived of the upload so far; none where nothing has. */
	arrived: (run: UploadRun, upload: FileUploadRow) => Promise<Result<UploadArrived | null, ApiError>>;
	/** Makes the file, or its next version, of what arrived, as the upload's agent's, for its task. */
	finish: (run: UploadRun, upload: FileUploadRow, arrived: UploadArrived) => Promise<Result<UploadMade, ApiError>>;
	/** Where the person opens the file the upload made. */
	link: (run: UploadRun, upload: FileUploadRow, made: UploadMade) => Promise<Result<string, ApiError>>;
	/** Lets go of what an upload nobody finished holds at the drive, as a session there. */
	expire: (upload: FileUploadRow) => Promise<Result<void, ApiError>>;
};

/** Where the bytes go: the URL, how to send them there, until when, and whether it takes them in parts (Content-Range). */
export type UploadPut = {url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: Date; resumable: boolean};

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

/** Starts an upload on the drive: checked and readied by the drive, kept, and answered with where its bytes go. */
export function startUpload(run: UploadRun, uploads: DriveUploads, target: UploadTarget, file: DeclaredFile): Promise<Result<UploadTicket, ApiError>> {
	return Do(async ($) => {
		const started = $(await uploads.start(run, target, file));
		const secret = randomBytes(32).toString('base64url');
		const sessionUri = started.to.kind === 'session' ? $(encryptSecret(started.to.url)) : null;
		const expiresAt = new Date(Date.now() + UPLOAD_TTL_MS);
		const {caller, connection} = run;
		const upload = $(
			await createFileUpload({
				orgId: connection.orgId,
				connectionId: connection.id,
				agentId: caller.agent.agentId,
				taskId: caller.taskId,
				via: caller.via,
				entryId: run.entryId ?? null,
				secretHash: started.to.kind === 'blob' ? hashUploadSecret(secret) : null,
				target: target.kind,
				parentId: target.kind === 'create' ? target.parentId : null,
				name: started.name,
				fileId: target.kind === 'write' ? target.fileId : started.fileId,
				version: target.kind === 'write' ? target.version : null,
				size: file.size,
				sha256: file.sha256,
				type: started.type,
				blobId: started.to.kind === 'blob' ? started.to.blobId : null,
				sessionUri,
				expiresAt,
			}),
		);
		const url = started.to.kind === 'session' ? started.to.url : hostedUrl(secret);
		const resumable = started.to.kind === 'session' && started.to.resumable;
		return {upload: upload.id, name: upload.name, size: upload.size, target: upload.target, put: {url, method: 'PUT' as const, headers: {}, expiresAt, resumable}};
	});
}

const EXPIRED = 'This upload expired: its URL takes bytes for an hour, and nothing arrived in time. Start again with files_upload.';

// What finishing an open upload came to: the file made; refused for good, with why; or nothing to
// finish yet, with why, or past its hour.
type Settled = {kind: 'made'; made: UploadMade} | {kind: 'failed'; why: string} | {kind: 'waiting'; why: string} | {kind: 'expired'};

function errorText(error: ApiError): string {
	return 'message' in error && error.message ? error.message : error.kind;
}

// What arrived, checked against what was said, and made into the file.
function settle(run: UploadRun, uploads: DriveUploads, upload: FileUploadRow, now: Date): Promise<Result<Settled, ApiError>> {
	return Do(async ($): Promise<Settled> => {
		const arrived = $(await uploads.arrived(run, upload));
		if (arrived === null) {
			if (upload.expiresAt <= now) {
				return {kind: 'expired'};
			}
			return {
				kind: 'waiting',
				why: `Nothing has arrived for upload ${upload.id} yet: PUT the file to the URL files_upload answered with, as curl -X PUT --upload-file <path> '<url>', then call files_upload_done again.`,
			};
		}
		if (arrived.size !== upload.size) {
			return {
				kind: 'failed',
				why: `${upload.name} was to be ${upload.size} bytes, and ${arrived.size} arrived, so nothing was made of it. Start again with files_upload, with the file’s size in bytes, as wc -c < <path> counts it.`,
			};
		}
		if (upload.sha256 !== null && arrived.sha256 !== null && arrived.sha256 !== upload.sha256) {
			return {
				kind: 'failed',
				why: `The bytes that arrived for ${upload.name} have the SHA-256 ${arrived.sha256}, not the ${upload.sha256} given, so nothing was made of them. Start again with files_upload, and send the file whose hash you gave.`,
			};
		}
		const made = await uploads.finish(run, upload, arrived);
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
		const settled = await settle(run, uploads, upload, now);
		if (settled.isErr()) {
			$(await unlockFileUpload(upload.id));
			return $(settled);
		}
		const {value} = settled;
		if (value.kind === 'waiting') {
			$(await unlockFileUpload(upload.id));
			return $(Err(ApiErr.validationError(value.why)));
		}
		if (value.kind === 'expired') {
			$(await expireFileUpload(upload.id));
			const letGo = await uploads.expire(upload);
			if (letGo.isErr()) {
				log.warn('An expired upload could not be let go of at its drive', {uploadId: upload.id, kind: letGo.error.kind});
			}
			return $(Err(ApiErr.conflict(EXPIRED)));
		}
		if (value.kind === 'failed') {
			$(await failFileUpload(upload.id, value.why));
			return $(Err(ApiErr.conflict(value.why)));
		}
		const finished = $(await finishFileUpload(upload.id, {fileId: value.made.fileId, afterVersion: value.made.version}));
		return $(await doneOf(run, uploads, finished, value.made));
	});
}
