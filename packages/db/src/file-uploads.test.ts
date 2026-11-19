import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {
	createFileUpload,
	expireFileUpload,
	findFileUploadBySecret,
	finishFileUpload,
	getFileUpload,
	listExpiredFileUploads,
	lockFileUpload,
	unlockFileUpload,
} from './file-uploads';

// Uploads' rows, against the local database: run with it up (`bun run dev`) and the environment
// loaded, `bun --env-file=../../.env test src/file-uploads.test.ts` from this package. Without
// DATABASE_URL, as `bun run test` runs, there is nothing to run against, and this is skipped.
// Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

const HOUR = 60 * 60_000;

describe.skipIf(!databaseUrl)('uploads, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let connectionId = '';
	let made = 0;

	// An upload of a new file, open until `expiresAt`.
	async function upload(expiresAt = new Date(Date.now() + HOUR), size = 10) {
		made += 1;
		return unwrap(
			await createFileUpload({
				orgId,
				connectionId,
				agentId: 'agent-1',
				taskId: 'task-1',
				via: 'mcp',
				entryId: null,
				secretHash: `hash-${stamp}-${made}`,
				target: 'create',
				parentId: null,
				name: `upload-${made}.pdf`,
				folders: [],
				convert: false,
				fileId: null,
				version: null,
				size,
				sha256: null,
				type: 'application/pdf',
				blobId: `blob-${stamp}-${made}`,
				expiresAt,
			}),
		);
	}

	beforeAll(async () => {
		const user = await db.user.create({data: {email: `file-uploads-test-${stamp}@example.test`}});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'File uploads test', slug: `file-uploads-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		// An integration of its own, so what the sweep's query finds of it is only this test's.
		const connection = await db.connection.create({
			data: {orgId, integrationId: `uploads-test-${stamp}`, account: 'Drive', credential: null},
		});
		connectionId = connection.id;
	});

	afterAll(async () => {
		if (orgId !== '') {
			await db.fileUpload.deleteMany({where: {orgId}});
			await db.connection.deleteMany({where: {orgId}});
			await db.organization.delete({where: {id: orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
	});

	test('keeps a size past what an integer holds, and finds an upload by its secret’s hash', async () => {
		const large = await upload(undefined, 5 * 1024 ** 3);
		expect(large.size).toBe(5 * 1024 ** 3);
		expect(unwrap(await findFileUploadBySecret(`hash-${stamp}-${made}`))?.id).toBe(large.id);
		expect(unwrap(await findFileUploadBySecret('no-such-hash'))).toBeNull();
		expect(unwrap(await getFileUpload('another-connection', large.id))).toBeNull();
	});

	test('lets one PUT or one done work on an upload at a time, a PUT only before its bytes are in and its hour is up', async () => {
		const now = new Date();
		const open = await upload();
		expect(unwrap(await lockFileUpload(open.id, {now, put: true}))).toBe(true);
		expect(unwrap(await lockFileUpload(open.id, {now, put: true}))).toBe(false);
		expect(unwrap(await lockFileUpload(open.id, {now, put: false}))).toBe(false);
		unwrap(await unlockFileUpload(open.id, {received: now}));
		// Its bytes in, no PUT takes it again; done does.
		expect(unwrap(await lockFileUpload(open.id, {now, put: true}))).toBe(false);
		expect(unwrap(await lockFileUpload(open.id, {now, put: false}))).toBe(true);
		const finished = unwrap(
			await finishFileUpload(open.id, {fileId: 'file-1', afterVersion: 'version-1'}),
		);
		expect(finished).toMatchObject({
			status: 'done',
			lockedAt: null,
			fileId: 'file-1',
			afterVersion: 'version-1',
		});
		expect(unwrap(await lockFileUpload(open.id, {now, put: false}))).toBe(false);

		const late = await upload(new Date(now.getTime() - 1000));
		expect(unwrap(await lockFileUpload(late.id, {now, put: true}))).toBe(false);
		expect(unwrap(await expireFileUpload(late.id))).toBe(true);
		expect(unwrap(await expireFileUpload(late.id))).toBe(false);
	});

	test('lists for the sweep what nothing is coming for past its hour, and anything still open an hour after', async () => {
		const now = new Date();
		const ago = (ms: number) => new Date(now.getTime() - ms);
		const idle = await upload(ago(1000));
		const sending = await upload(ago(1000));
		unwrap(await lockFileUpload(sending.id, {now: ago(2000), put: false}));
		const arrived = await upload(ago(1000));
		unwrap(await unlockFileUpload(arrived.id, {received: ago(2000)}));
		const forgotten = await upload(ago(HOUR + 1000));
		unwrap(await unlockFileUpload(forgotten.id, {received: ago(HOUR + 2000)}));
		await upload();

		const listed = unwrap(await listExpiredFileUploads({now, graceMs: HOUR, limit: 100})).filter(
			(found) => found.connectionId === connectionId,
		);
		expect(listed.map((found) => found.id).toSorted()).toEqual([idle.id, forgotten.id].toSorted());
	});
});
