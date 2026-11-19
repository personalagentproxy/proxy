import type {AuditVia, FileUploadStatus, FileUploadTarget, Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * Uploads into a drive through a URL (schema.prisma FileUpload): what a call said it would send,
 * where the bytes go and where the upload stands. The api's uploads module starts and finishes
 * them, for every kind of drive; what is kept here holds whoever asks: a PUT takes an upload only
 * while it is open, not yet filled and not yet past its hour, and one PUT or one
 * files_upload_done works on an upload at a time (`lockFileUpload`).
 */

export type {FileUploadStatus, FileUploadTarget};

export type FileUploadRow = {
	id: string;
	orgId: string;
	connectionId: string;
	agentId: string;
	taskId: string;
	via: AuditVia;
	entryId: string | null;
	target: FileUploadTarget;
	parentId: string | null;
	name: string;
	// A new file's folders to make on the way, at done, the first in `parentId`.
	folders: string[];
	convert: boolean;
	fileId: string | null;
	version: string | null;
	// In bytes; kept as a big integer, as the column is.
	size: number;
	sha256: string | null;
	type: string;
	blobId: string;
	status: FileUploadStatus;
	lockedAt: Date | null;
	receivedAt: Date | null;
	afterVersion: string | null;
	failure: string | null;
	expiresAt: Date;
	createdAt: Date;
};

const uploadSelect = {
	id: true,
	orgId: true,
	connectionId: true,
	agentId: true,
	taskId: true,
	via: true,
	entryId: true,
	target: true,
	parentId: true,
	name: true,
	folders: true,
	convert: true,
	fileId: true,
	version: true,
	size: true,
	sha256: true,
	type: true,
	blobId: true,
	status: true,
	lockedAt: true,
	receivedAt: true,
	afterVersion: true,
	failure: true,
	expiresAt: true,
	createdAt: true,
} as const;

function toRow(row: Prisma.FileUploadGetPayload<{select: typeof uploadSelect}>): FileUploadRow {
	return {...row, size: Number(row.size)};
}

/** A new upload, open until `expiresAt`. */
export function createFileUpload(data: {
	orgId: string;
	connectionId: string;
	agentId: string;
	taskId: string;
	via: AuditVia;
	entryId: string | null;
	secretHash: string;
	target: FileUploadTarget;
	parentId: string | null;
	name: string;
	folders: string[];
	convert: boolean;
	fileId: string | null;
	version: string | null;
	size: number;
	sha256: string | null;
	type: string;
	blobId: string;
	expiresAt: Date;
}): Promise<Result<FileUploadRow, ApiError>> {
	return wrapDb(async () =>
		toRow(
			await db.fileUpload.create({
				data: {...data, size: BigInt(data.size)},
				select: uploadSelect,
			}),
		),
	);
}

/** One of the connection's uploads, by its id; none for another's. */
export function getFileUpload(
	connectionId: string,
	id: string,
): Promise<Result<FileUploadRow | null, ApiError>> {
	return wrapDb(async () => {
		const found = await db.fileUpload.findFirst({where: {id, connectionId}, select: uploadSelect});
		return found === null ? null : toRow(found);
	});
}

/** The upload whose URL holds the secret of this hash; none where no upload's does. */
export function findFileUploadBySecret(
	secretHash: string,
): Promise<Result<FileUploadRow | null, ApiError>> {
	return wrapDb(async () => {
		const found = await db.fileUpload.findUnique({where: {secretHash}, select: uploadSelect});
		return found === null ? null : toRow(found);
	});
}

/**
 * Takes an open upload to work on, where nothing else has it: for a PUT, only one whose bytes are
 * not in yet, before it expires; for files_upload_done, any open one. Whether it took it.
 */
export function lockFileUpload(
	id: string,
	data: {now: Date; put: boolean},
): Promise<Result<boolean, ApiError>> {
	return wrapDb(async () => {
		const forPut = data.put ? {receivedAt: null, expiresAt: {gt: data.now}} : {};
		const {count} = await db.fileUpload.updateMany({
			where: {id, status: 'open', lockedAt: null, ...forPut},
			data: {lockedAt: data.now},
		});
		return count > 0;
	});
}

/** Lets an upload go again, open; with `received`, its bytes all in by then. */
export function unlockFileUpload(
	id: string,
	data: {received?: Date} = {},
): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.fileUpload.update({
			where: {id},
			data: {lockedAt: null, ...(data.received === undefined ? {} : {receivedAt: data.received})},
		});
	});
}

/** An upload made into its file, at that version: done, whatever it stood at. */
export function finishFileUpload(
	id: string,
	data: {fileId: string; afterVersion: string},
): Promise<Result<FileUploadRow, ApiError>> {
	return wrapDb(async () =>
		toRow(
			await db.fileUpload.update({
				where: {id},
				data: {...data, status: 'done', lockedAt: null},
				select: uploadSelect,
			}),
		),
	);
}

/** An upload refused at the end, for good, with why. */
export function failFileUpload(id: string, failure: string): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.fileUpload.update({
			where: {id},
			data: {status: 'failed', failure, lockedAt: null},
		});
	});
}

/** An open upload let go, unfinished; whether it was open still. */
export function expireFileUpload(id: string): Promise<Result<boolean, ApiError>> {
	return wrapDb(async () => {
		const {count} = await db.fileUpload.updateMany({
			where: {id, status: 'open'},
			data: {status: 'expired', lockedAt: null},
		});
		return count > 0;
	});
}

/**
 * The open uploads to let go, oldest first: those past `expiresAt` that nothing is coming in for
 * and that hold no bytes, and every one past `expiresAt` by `graceMs` or more, whatever it holds or
 * whoever has it, as one whose bytes came in but that no files_upload_done finished.
 */
export function listExpiredFileUploads(data: {
	now: Date;
	graceMs: number;
	limit: number;
}): Promise<Result<FileUploadRow[], ApiError>> {
	return wrapDb(async () => {
		const rows = await db.fileUpload.findMany({
			where: {
				status: 'open',
				OR: [
					{expiresAt: {lt: data.now}, lockedAt: null, receivedAt: null},
					{expiresAt: {lt: new Date(data.now.getTime() - data.graceMs)}},
				],
			},
			select: uploadSelect,
			orderBy: {expiresAt: 'asc'},
			take: data.limit,
		});
		return rows.map(toRow);
	});
}
