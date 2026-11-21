import type {Request, Response} from 'express';
import {Err, type Result} from 'ts-results-es';

import {type ApiError, apiErrorMessage, Do} from '@proxy/utils';
import type {BlobRefused, BlobStored} from '@proxy/contracts/blobs';
import {getSignedInAgentById} from '@proxy/db/agent';

import {openContent, requestBytes, sendContent, setDownloadHeaders} from '../native/files/content';
import {log, serializeError} from '../observability/log';
import {env} from '../utils/env';
import {type AgentBlob, type BlobOwner, requireBlob, storeBlob} from './blobs';
import {type BlobClaims, verifyBlobToken} from './token';

/**
 * A blob's URLs (@proxy/contracts/blobs), from anything that has one, a model's `curl` or a
 * sandbox's `pap`: the token in the address is the one credential, so there is no session and no
 * origin check, and the address is never logged (server/middleware/request-logger.ts).
 * - `PUT /api/blobs/:token[?name=]`: the body, read as it comes, counted and hashed as it passes,
 *   becomes a new blob of the token's agent. More than a file may be is refused as it comes.
 * - `GET /api/blobs/:token`: the bytes of the blob the token names.
 */

type Refusal = {status: number; body: BlobRefused};

function refused(status: number, error: string, message: string): Refusal {
	return {status, body: {error, message}};
}

const INVALID = refused(403, 'forbidden', 'This URL takes nothing. pap.upload() answers with a URL to send a file to, and pap.download(blob) with one to fetch a blob from.');

const EXPIRED = refused(410, 'expired', 'This URL worked for an hour, and the hour is up. Ask pap.upload() or pap.download(blob) for another.');

// The api's error, as these routes answer it; the server's own failures said plainly, and logged.
function fromApiError(error: ApiError): Refusal {
	if (error.statusCode >= 500) {
		log.error('A blob’s bytes could not be moved', {kind: error.kind, ...('cause' in error ? serializeError(error.cause) : {})});
		return refused(error.statusCode, error.kind, 'The server failed: try again.');
	}
	return refused(error.statusCode, error.kind, apiErrorMessage(error) ?? error.kind);
}

// What the address's token lets do.
function claimsOf(request: Request): Result<BlobClaims, Refusal> {
	if (!env.AUTH_SECRET) {
		return Err(INVALID);
	}
	return verifyBlobToken(request.params.token ?? '', env.AUTH_SECRET).mapErr((why) => (why === 'expired' ? EXPIRED : INVALID));
}

// The token's agent, still there: one revoked since moves nothing more.
function requireAgent(owner: BlobOwner): Promise<Result<void, Refusal>> {
	return Do(async ($) => {
		const agent = $((await getSignedInAgentById(owner.orgId, owner.agentId)).mapErr(fromApiError));
		if (agent === null) {
			return $(Err(INVALID));
		}
	});
}

// The file's name as the PUT says it, which the blob keeps without any folders before it (blobs.ts `storeBlob`); none where it says none.
function nameOf(request: Request): string | null {
	const said = request.query.name;
	return typeof said === 'string' ? said : null;
}

function receive(request: Request): Promise<Result<BlobStored, Refusal>> {
	return Do(async ($) => {
		const claims = $(claimsOf(request));
		if (claims.kind !== 'put') {
			return $(Err(INVALID));
		}
		const owner: BlobOwner = {orgId: claims.orgId, agentId: claims.agentId};
		$(await requireAgent(owner));
		const body = $(requestBytes(request).mapErr(fromApiError));
		const stored = await storeBlob(owner, {name: nameOf(request), type: null}, body);
		if (stored.isErr()) {
			const {error} = stored;
			return $(Err(error.kind === 'validation_error' ? refused(413, 'too_large', error.message) : fromApiError(error)));
		}
		const blob = stored.value;
		return {blob: blob.id, name: blob.name, size: blob.size, sha256: blob.sha256};
	});
}

/** `PUT /api/blobs/:token`: a file's bytes, made a blob, answered with its id. */
export async function handleBlobPutRoute(request: Request, response: Response): Promise<void> {
	const received = await receive(request);
	if (received.isErr()) {
		// What is left of a body nobody read is read and dropped, so the answer reaches whoever sends it.
		request.resume();
		response.status(received.error.status).json(received.error.body);
		return;
	}
	response.status(200).json(received.value);
}

// The blob the token names, and its bytes, while its agent is still there.
function open(request: Request): Promise<Result<{blob: AgentBlob; body: ReadableStream<Uint8Array>}, Refusal>> {
	return Do(async ($) => {
		const claims = $(claimsOf(request));
		if (claims.kind !== 'get') {
			return $(Err(INVALID));
		}
		const owner: BlobOwner = {orgId: claims.orgId, agentId: claims.agentId};
		$(await requireAgent(owner));
		const blob = $((await requireBlob(owner, claims.blobId)).mapErr(fromApiError));
		return {blob, body: $((await openContent(blob)).mapErr(fromApiError))};
	});
}

/** `GET /api/blobs/:token`: the bytes of the blob the token names, sent to be saved, as a drive's file's are. */
export async function handleBlobGetRoute(request: Request, response: Response): Promise<void> {
	const opened = await open(request);
	if (opened.isErr()) {
		response.status(opened.error.status).json(opened.error.body);
		return;
	}
	const {blob, body} = opened.value;
	response.status(200);
	setDownloadHeaders(response, {name: blob.name ?? blob.id, type: blob.type ?? 'application/octet-stream', size: blob.size}, false);
	const sent = await sendContent(response, body);
	if (sent.isErr()) {
		log.warn('A blob fetched failed partway', {blobId: blob.id, ...serializeError(sent.error)});
	}
}
