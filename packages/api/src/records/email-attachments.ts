import type Mail from 'nodemailer/lib/mailer';
import {Err, Ok, Result} from 'ts-results-es';

import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {formatBytes} from '@proxy/utils/bytes';

import {blobType, requireBlob, storeBlob} from '../blobs/blobs';
import {openContent, streamOf} from '../native/files/content';
import type {AttachmentFile} from './attachment-text';
import type {DataRecord, RecordTarget} from './connector';

/**
 * An email's attachments as an agent's blobs (blobs/), both ways, whatever the mailbox: one of an
 * email's attachments made a blob, as the `attachments` collection's `blob` command does, and the
 * files an email goes out with: an agent's blobs, named in the
 * `attach` an email or a reply is written with, their ids separated by commas, and the attachments
 * a draft has already, which an edit of it and sending it keep. A blob is attached under its own
 * name, as the tool that made it said it, `attachments_blob` of another email's attachment,
 * `files_blob` of a drive's file, or a file sent to the URL `pap.upload()` answers with; so
 * forwarding an attachment, or attaching a file of a drive, is a blob made and a blob attached.
 * Each mailbox writes the message in its own terms; what is attached is the same here.
 */

/** A file an email goes out with: its name, its media type and its bytes, and the id its HTML shows it by where it is a picture in the text. */
export type Attached = {filename: string; contentType: string; content: Buffer; cid?: string};

/**
 * How much an email carries in attachments, as their bytes: what Gmail takes, and about what any
 * mailbox does. They are held whole while the message is written, so this is also what that costs.
 */
export const MAX_ATTACHED_BYTES = 25 * 1024 * 1024;

/** Refuses attachments that come to more than an email carries. */
export function requireAttachable(attached: Pick<Attached, 'content'>[]): Result<void, ApiError> {
	return requireTotal(attached.reduce((total, one) => total + one.content.length, 0));
}

function requireTotal(bytes: number): Result<void, ApiError> {
	if (bytes <= MAX_ATTACHED_BYTES) {
		return Ok(undefined);
	}
	return Err(
		ApiErr.validationError(`An email carries at most ${formatBytes(MAX_ATTACHED_BYTES)} of attachments, and these come to ${formatBytes(bytes)}: put the file in a drive and send its link instead.`),
	);
}

// The blobs `attach` names, each once, in the order written.
function blobIds(attach: string | undefined): string[] {
	const ids = (attach ?? '')
		.split(/[\s,]+/)
		.map((id) => id.trim())
		.filter((id) => id !== '');
	return [...new Set(ids)];
}

async function bytesOf(body: ReadableStream<Uint8Array>): Promise<Result<Buffer, ApiError>> {
	const read = await Result.wrapAsync(async () => Buffer.from(await new Response(body).arrayBuffer()));
	return read.mapErr((cause) => ApiErr.internalError(cause));
}

/**
 * The agent's blobs `attach` names, as files to attach: none where it names none. Only the agent
 * that made a blob attaches it, so a member, who has none, attaches nothing here.
 */
export function attachedBlobs(target: RecordTarget, attach: string | undefined): Promise<Result<Attached[], ApiError>> {
	return Do(async ($) => {
		const ids = blobIds(attach);
		if (ids.length === 0) {
			return [];
		}
		const {by} = target;
		if (by === undefined || !('agentId' in by)) {
			return $(Err(ApiErr.validationError('attach takes an agent’s blobs: only an agent attaches one')));
		}
		const owner = {orgId: target.connection.orgId, agentId: by.agentId};
		const blobs = [];
		for (const id of ids) {
			blobs.push($(await requireBlob(owner, id)));
		}
		$(requireTotal(blobs.reduce((total, blob) => total + blob.size, 0)));
		const attached: Attached[] = [];
		for (const [index, blob] of blobs.entries()) {
			const filename = blob.name ?? `attachment-${index + 1}`;
			const content = $(await bytesOf($(await openContent(blob))));
			attached.push({filename, contentType: blobType(blob, filename), content});
		}
		return attached;
	});
}

/** The files as nodemailer attaches them to a message: a picture the HTML shows, by its id, in the text, and any other below it. */
export function attachmentOptions(attached: Attached[]): Mail.Options {
	if (attached.length === 0) {
		return {};
	}
	return {
		attachments: attached.map(({filename, contentType, content, cid}) => ({
			filename,
			contentType,
			content,
			...(cid === undefined ? {} : {cid, contentDisposition: 'inline' as const}),
		})),
	};
}

/**
 * An attachment made a blob of the agent's, as the `attachments` collection's `blob` command
 * answers it: to put in a drive with files_upload, attach to another email, or fetch with
 * pap.download, whatever kind of file it is.
 */
export function attachmentBlobRecord(target: RecordTarget, email: string, number: number, file: AttachmentFile): Promise<Result<DataRecord, ApiError>> {
	return Do(async ($) => {
		const {by} = target;
		if (by === undefined || !('agentId' in by)) {
			return $(Err(ApiErr.validationError('A blob is an agent’s: only an agent makes one')));
		}
		const owner = {orgId: target.connection.orgId, agentId: by.agentId};
		const blob = $(await storeBlob(owner, {name: file.name || null, type: file.type || null}, streamOf(file.bytes)));
		const values = {email, attachment: String(number), name: file.name, type: file.type, size: formatBytes(blob.size), blob: blob.id};
		return {id: `${email}/${number}`, values, updatedAt: new Date().toISOString()};
	});
}
