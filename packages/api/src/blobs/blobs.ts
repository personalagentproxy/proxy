import {Err, Ok, type Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';
import {BLOBS_PATH, type BlobDownload, type BlobUpload} from '@proxy/contracts/blobs';
import type {SignedInAgent} from '@proxy/db/agent';
import {createFileBlob, type FileBlobRow, getFileBlob} from '@proxy/db/files';

import {blobBackend} from '../backends/backends';
import {fillBlob, maxFileBytes, newBlobKey} from '../native/files/content';
import {mediaType} from '../native/files/names';
import {env} from '../utils/env';
import {signBlobToken} from './token';

/**
 * Blobs, the one way a file moves through Personal Agent Proxy (@proxy/contracts/blobs): bytes in
 * the server's blob store (native/files/content.ts), made by one agent and used only by it. A tool
 * on the connection a file is in makes a blob of it, through that connection's gate, as reading it
 * is: `attachments_blob` of an email's attachment, `files_blob` of a drive's file. A tool on the
 * connection it goes to takes the blob, through that one's: `files_upload` puts it in a drive. So
 * every step is checked and logged on its own connection, and nothing is particular to a pair of
 * them. Bytes from outside, a model's shell or a sandbox, come in through a URL `pap.upload()`
 * answers with, and go out through one `pap.download(blob)` does (route.ts).
 *
 * A blob is kept for a day: no version points at it, so the sweep of unused blobs takes it then
 * (native/files/sweeper.ts), and it is refused a while before, so it is never taken while used.
 * One put in a drive of Files is a version of the file from then on, and kept as long as it is.
 */

/** Whose blobs: the agent, in its organization. */
export type BlobOwner = {orgId: string; agentId: string};

/** A blob whose bytes are all in, with their SHA-256. */
export type AgentBlob = FileBlobRow & {sha256: string};

/** What a blob is a file of, as its source names it: its name and media type, where it says. */
export type BlobFile = {name: string | null; type: string | null};

// How long after it was made a blob is used: short of the day the sweep leaves it.
const USABLE_MS = 23 * 60 * 60_000;

/** How long a URL to send bytes to, or to fetch them from, works. */
export const BLOB_URL_MS = 60 * 60_000;

export function ownerOf(agent: Pick<SignedInAgent, 'orgId' | 'agentId'>): BlobOwner {
	return {orgId: agent.orgId, agentId: agent.agentId};
}

/** Stores what `body` gives as a new blob of the owner's; refused where it is larger than a file may be. */
export function storeBlob(owner: BlobOwner, file: BlobFile, body: ReadableStream<Uint8Array>): Promise<Result<AgentBlob, ApiError>> {
	return Do(async ($) => {
		const backend = await blobBackend();
		const blob = $(await createFileBlob({orgId: owner.orgId, backendId: backend.id, key: newBlobKey(owner.orgId), agentId: owner.agentId, name: file.name, type: file.type}));
		const stored = $(await fillBlob(blob, body, maxFileBytes()));
		return {...blob, size: stored.size, sha256: stored.sha256};
	});
}

function notYours(id: string): ApiError {
	return ApiErr.notFound(
		'blob',
		id,
		`There is no blob ${id} of yours. A blob is made by a tool that hands over a file, as attachments_blob or files_blob, or by sending bytes to the URL pap.upload() answers with.`,
	);
}

/** The owner's blob `id`, whole and still kept; not found for anyone else's. */
export function requireBlob(owner: BlobOwner, id: string, now = new Date()): Promise<Result<AgentBlob, ApiError>> {
	return Do(async ($) => {
		const blob = $(requirePresent($(await getFileBlob(id)), notYours(id)));
		if (blob.orgId !== owner.orgId || blob.agentId !== owner.agentId || blob.sha256 === null) {
			return $(Err(notYours(id)));
		}
		if (now.getTime() - blob.createdAt.getTime() > USABLE_MS) {
			return $(Err(ApiErr.notFound('blob', id, `Blob ${id} is gone: a blob is kept for a day. Make it again from where the file is.`)));
		}
		return {...blob, sha256: blob.sha256};
	});
}

/**
 * What a blob put in a file called `name` holds, as a media type: by the name's extension, else by
 * the blob's own name's, as a file converted on its way goes without one, else as its source
 * called it.
 */
export function blobType(blob: BlobFile, name: string): string {
	return mediaType(name, mediaType(blob.name ?? '', blob.type ?? undefined, 'bytes'), 'bytes');
}

/** A blob as a tool answers it, a line each: what the next call needs, its id first. */
export function blobLines(blob: AgentBlob): string[] {
	return [`Blob: ${blob.id}`, ...(blob.name === null ? [] : [`Name: ${blob.name}`]), ...(blob.type === null ? [] : [`Type: ${blob.type}`]), `Size: ${formatBytes(blob.size)}`];
}

// The server's secret and address, which a blob's URL is made of.
function urlConfig(): Result<{secret: string; appUrl: string}, ApiError> {
	const {AUTH_SECRET: secret, APP_URL: appUrl} = env;
	if (secret && appUrl) {
		return Ok({secret, appUrl});
	}
	return Err(ApiErr.unavailable('This server gives no URLs for files: AUTH_SECRET or APP_URL is not set.'));
}

function expiry(now: Date): {expiresAt: Date; seconds: number} {
	const expiresAt = new Date(now.getTime() + BLOB_URL_MS);
	return {expiresAt, seconds: Math.floor(expiresAt.getTime() / 1000)};
}

/** Where the owner sends a file's bytes, with PUT, for each to become a blob of theirs. */
export function blobUploadUrl(owner: BlobOwner, now = new Date()): Result<BlobUpload, ApiError> {
	return urlConfig().map(({secret, appUrl}) => {
		const {expiresAt, seconds} = expiry(now);
		const token = signBlobToken({kind: 'put', ...owner, expiresAt: seconds}, secret);
		return {url: `${appUrl}${BLOBS_PATH}/${token}`, method: 'PUT' as const, expiresAt: expiresAt.toISOString()};
	});
}

/** Where the owner fetches the bytes of their blob `id`, with GET. */
export function blobDownloadUrl(owner: BlobOwner, id: string, now = new Date()): Promise<Result<BlobDownload, ApiError>> {
	return Do(async ($) => {
		const blob = $(await requireBlob(owner, id, now));
		const {secret, appUrl} = $(urlConfig());
		const {expiresAt, seconds} = expiry(now);
		const token = signBlobToken({kind: 'get', ...owner, blobId: blob.id, expiresAt: seconds}, secret);
		return {blob: blob.id, name: blob.name, type: blob.type, size: blob.size, url: `${appUrl}${BLOBS_PATH}/${token}`, expiresAt: expiresAt.toISOString()};
	});
}
