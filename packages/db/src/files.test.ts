import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {
	completeFileBlob,
	createFile,
	createFileBlob,
	createFolder,
	createMissingFilesConnection,
	deleteUnusedFileBlob,
	FILE_CHANGED,
	getFile,
	getFileVersion,
	listFileVersions,
	listFolder,
	listTrash,
	listTrashedBefore,
	listUnusedFileBlobs,
	moveFile,
	purgeTrashed,
	restoreFileVersion,
	searchFiles,
	trashFile,
	untrashFile,
	writeFile,
	type FileChangeBy,
	type NewContent,
} from './files';

// A drive's tree, versions and journal, against the local database: run with it up
// (`bun run dev`) and the environment loaded, `bun --env-file=../../.env test src/files.test.ts`
// from this package. Without DATABASE_URL, as `bun run test` runs, there is nothing to run
// against, and this is skipped. Everything made here is one organization's, deleted at the end.
const databaseUrl = process.env.DATABASE_URL;

function unwrap<T>(result: Result<T, ApiError>): T {
	if (result.isErr()) {
		throw new Error(JSON.stringify(result.error));
	}
	return result.value;
}

function refusal<T>(result: Result<T, ApiError>): string {
	if (result.isOk()) {
		throw new Error('expected a refusal');
	}
	return 'message' in result.error && result.error.message
		? `${result.error.kind}: ${result.error.message}`
		: result.error.kind;
}

describe.skipIf(!databaseUrl)('files, against the database', () => {
	const stamp = `${Date.now()}-${process.pid}`;
	let userId = '';
	let orgId = '';
	let connectionId = '';
	let person: FileChangeBy;
	let agent: FileChangeBy;
	let blobs = 0;

	// Content to point a version at: a blob's row, as the api makes one once the bytes are stored.
	async function content(size = 10, type = 'text/plain'): Promise<NewContent> {
		blobs += 1;
		const blob = unwrap(
			await createFileBlob({orgId, backendId: 'disk', key: `${orgId}/blob-${stamp}-${blobs}`}),
		);
		unwrap(await completeFileBlob(blob.id, {size, sha256: `hash-${blobs}`}));
		return {blobId: blob.id, size, type};
	}

	beforeAll(async () => {
		const user = await db.user.create({
			data: {email: `files-test-${stamp}@example.test`, name: 'Dana'},
		});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Files test', slug: `files-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		unwrap(
			await createMissingFilesConnection({
				orgId,
				userId,
				integrationId: 'files',
				defaults: ['readFiles'],
			}),
		);
		unwrap(
			await createMissingFilesConnection({
				orgId,
				userId,
				integrationId: 'files',
				defaults: ['readFiles'],
			}),
		);
		const connections = await db.connection.findMany({
			where: {orgId, integrationId: 'files'},
			include: {defaults: true},
		});
		expect(connections).toHaveLength(1);
		expect(connections[0]?.account).toBe('Files test');
		expect(connections[0]?.defaults.map((stored) => stored.actionId)).toEqual(['readFiles']);
		connectionId = connections[0]?.id ?? '';
		const task = await db.agentTask.create({
			data: {orgId, agentId: 'agent-1', title: 'Tidy the reports', goal: 'Tidy up', via: 'mcp'},
		});
		person = {orgId, connectionId, by: {userId}};
		agent = {orgId, connectionId, by: {agentId: 'agent-1', taskId: task.id}};
	});

	afterAll(async () => {
		if (orgId !== '') {
			// The drive goes with the organization, its versions with it; the blobs they pointed at stay
			// until they are forgotten, as the sweep would.
			await db.organization.delete({where: {id: orgId}});
			await db.fileBlob.deleteMany({where: {orgId}});
		}
		if (userId !== '') {
			await db.user.delete({where: {id: userId}});
		}
	});

	test('keeps a tree of folders and files, each name its folder’s only one, listed folders first', async () => {
		const reports = unwrap(await createFolder(person, {parentId: null, name: 'Reports'}));
		const notes = unwrap(
			await createFile(person, {parentId: null, name: 'notes.md', content: await content()}),
		);
		const q3 = unwrap(
			await createFile(person, {parentId: reports.id, name: 'q3.md', content: await content(42)}),
		);

		expect(unwrap(await listFolder(connectionId, null)).map((entry) => entry.name)).toEqual([
			'Reports',
			'notes.md',
		]);
		expect(
			unwrap(await listFolder(connectionId, reports.id)).map((entry) => [
				entry.name,
				entry.head?.size,
			]),
		).toEqual([['q3.md', 42]]);
		expect(
			refusal(
				await createFile(person, {parentId: null, name: 'notes.md', content: await content()}),
			),
		).toBe('conflict: Something is already called notes.md there.');
		expect(refusal(await createFolder(person, {parentId: null, name: 'Reports'}))).toBe(
			'conflict: Something is already called Reports there.',
		);
		expect(
			refusal(await createFolder(person, {parentId: notes.id, name: 'Inside a file'})),
		).toStartWith('not_found');
		// The same name is free in another folder, and an upload takes the first free name like its own.
		unwrap(
			await createFile(person, {parentId: reports.id, name: 'notes.md', content: await content()}),
		);
		expect(
			unwrap(
				await createFile(person, {
					parentId: null,
					name: 'notes.md',
					content: await content(),
					rename: true,
				}),
			).name,
		).toBe('notes (2).md');
		expect(
			unwrap(
				await createFile(person, {
					parentId: null,
					name: 'notes.md',
					content: await content(),
					rename: true,
				}),
			).name,
		).toBe('notes (3).md');

		const found = unwrap(await getFile(connectionId, q3.id));
		expect(found?.trail.map((folder) => folder.name)).toEqual(['Reports']);
		expect(found?.trashed).toBe(false);
		expect(unwrap(await getFile(connectionId, 'no-such-file'))).toBeNull();
	});

	test('writes a file’s next version only for whoever read the one it holds, and keeps every one before', async () => {
		const file = unwrap(
			await createFile(person, {parentId: null, name: 'plan.md', content: await content(1)}),
		);
		const first = file.head?.id ?? '';

		const second = unwrap(
			await writeFile(agent, {fileId: file.id, ifVersion: first, content: await content(2)}),
		);
		expect(second.head?.id).not.toBe(first);
		// Whoever still has the first version in hand is refused, and nothing is written.
		expect(
			refusal(
				await writeFile(person, {fileId: file.id, ifVersion: first, content: await content(3)}),
			),
		).toBe(`conflict: ${FILE_CHANGED}`);
		const third = unwrap(
			await writeFile(person, {
				fileId: file.id,
				ifVersion: second.head?.id ?? '',
				content: await content(3),
			}),
		);

		const versions = unwrap(await listFileVersions(connectionId, file.id));
		expect(versions.map((version) => version.size)).toEqual([3, 2, 1]);
		expect(
			versions.map((version) => [
				version.author?.kind,
				version.author?.user?.name ?? version.author?.task?.title,
			]),
		).toEqual([
			['write', 'Dana'],
			['write', 'Tidy the reports'],
			['create', 'Dana'],
		]);
		expect(unwrap(await getFile(connectionId, file.id))?.head?.id).toBe(third.head?.id);
		expect(unwrap(await getFileVersion(connectionId, file.id, first))?.blob.sha256).toStartWith(
			'hash-',
		);
		expect(unwrap(await getFileVersion(connectionId, 'another-file', first))).toBeNull();
	});

	test('gives an earlier version back as a new one of the same blob, losing nothing', async () => {
		const file = unwrap(
			await createFile(person, {parentId: null, name: 'draft.md', content: await content(1)}),
		);
		const first = file.head?.id ?? '';
		const second = unwrap(
			await writeFile(agent, {fileId: file.id, ifVersion: first, content: await content(2)}),
		);

		const restored = unwrap(await restoreFileVersion(person, {fileId: file.id, versionId: first}));

		expect(restored.head?.size).toBe(1);
		expect(restored.head?.id).not.toBe(first);
		const versions = unwrap(await listFileVersions(connectionId, file.id));
		expect(versions.map((version) => [version.size, version.author?.kind])).toEqual([
			[1, 'restore'],
			[2, 'write'],
			[1, 'create'],
		]);
		expect(versions[0]?.blobId).toBe(versions[2]?.blobId);
		// Giving back what it holds already changes nothing.
		expect(
			unwrap(
				await restoreFileVersion(person, {fileId: file.id, versionId: restored.head?.id ?? ''}),
			).head?.id,
		).toBe(restored.head?.id);
		expect(unwrap(await listFileVersions(connectionId, file.id))).toHaveLength(3);
		expect(
			refusal(
				await restoreFileVersion(person, {
					fileId: file.id,
					versionId: second.head?.id.slice(0, -1) ?? '',
				}),
			),
		).toStartWith('not_found');
	});

	test('renames and moves, never onto a name that is taken nor a folder into itself', async () => {
		const outer = unwrap(await createFolder(person, {parentId: null, name: 'Outer'}));
		const inner = unwrap(await createFolder(person, {parentId: outer.id, name: 'Inner'}));
		const file = unwrap(
			await createFile(person, {parentId: null, name: 'loose.txt', content: await content()}),
		);
		unwrap(
			await createFile(person, {parentId: inner.id, name: 'taken.txt', content: await content()}),
		);

		const moved = unwrap(
			await moveFile(agent, {id: file.id, parentId: inner.id, name: 'filed.txt'}),
		);
		expect([moved.parentId, moved.name]).toEqual([inner.id, 'filed.txt']);
		expect(
			unwrap(await getFile(connectionId, file.id))?.trail.map((folder) => folder.name),
		).toEqual(['Outer', 'Inner']);
		expect(refusal(await moveFile(agent, {id: file.id, name: 'taken.txt'}))).toBe(
			'conflict: Something is already called taken.txt there.',
		);
		expect(refusal(await moveFile(person, {id: outer.id, parentId: inner.id}))).toBe(
			'validation_error: A folder can’t be moved inside itself.',
		);
		expect(refusal(await moveFile(person, {id: outer.id, parentId: outer.id}))).toBe(
			'validation_error: A folder can’t be moved inside itself.',
		);
		// Back to the top, keeping its name.
		expect(unwrap(await moveFile(person, {id: file.id, parentId: null})).parentId).toBeNull();

		const journal = await db.fileChange.findMany({
			where: {connectionId, fileId: file.id, kind: 'move'},
			orderBy: {createdAt: 'asc'},
		});
		expect(
			journal.map((change) => [
				change.beforeParentId,
				change.beforeName,
				change.name,
				change.agentId,
				change.userId,
			]),
		).toEqual([
			[null, 'loose.txt', 'filed.txt', 'agent-1', null],
			[inner.id, 'filed.txt', 'filed.txt', null, userId],
		]);
	});

	test('puts a folder in the trash with everything in it, where nothing is written, and takes it out again', async () => {
		const folder = unwrap(await createFolder(person, {parentId: null, name: 'Old'}));
		const file = unwrap(
			await createFile(person, {parentId: folder.id, name: 'keep.txt', content: await content()}),
		);

		unwrap(await trashFile(agent, folder.id));

		expect(unwrap(await listFolder(connectionId, null)).map((entry) => entry.name)).not.toContain(
			'Old',
		);
		expect(unwrap(await getFile(connectionId, file.id))?.trashed).toBe(true);
		expect(unwrap(await listTrash(connectionId)).map((entry) => entry.name)).toEqual(['Old']);
		expect(
			refusal(
				await writeFile(person, {
					fileId: file.id,
					ifVersion: file.head?.id ?? '',
					content: await content(),
				}),
			),
		).toBe('not_found: It is in the trash.');
		expect(
			refusal(
				await createFile(person, {parentId: folder.id, name: 'new.txt', content: await content()}),
			),
		).toBe('not_found: That folder is in the trash.');
		expect(unwrap(await searchFiles(connectionId, 'keep', null))).toEqual([]);
		// Its name is free meanwhile, so taking it out again is refused once something has it.
		const usurper = unwrap(await createFolder(person, {parentId: null, name: 'Old'}));
		expect(refusal(await untrashFile(person, folder.id))).toBe(
			'conflict: Something else is called Old there now: rename that first.',
		);
		unwrap(await moveFile(person, {id: usurper.id, name: 'Newer'}));

		unwrap(await untrashFile(person, folder.id));

		expect(unwrap(await getFile(connectionId, file.id))?.trashed).toBe(false);
		expect(
			unwrap(await searchFiles(connectionId, 'KEEP', null)).map((entry) =>
				entry.trail.map((crumb) => crumb.name),
			),
		).toEqual([['Old']]);
		expect(unwrap(await searchFiles(connectionId, 'keep', usurper.id))).toEqual([]);
		expect(refusal(await untrashFile(person, folder.id))).toStartWith('not_found');
	});

	test('deletes what is in the trash for good, and leaves its blobs for the sweep to forget', async () => {
		const folder = unwrap(await createFolder(person, {parentId: null, name: 'Doomed'}));
		const first = await content();
		const file = unwrap(
			await createFile(person, {parentId: folder.id, name: 'gone.txt', content: first}),
		);
		const second = await content();
		unwrap(
			await writeFile(person, {fileId: file.id, ifVersion: file.head?.id ?? '', content: second}),
		);
		const later = new Date(Date.now() + 60_000);

		// Nothing outside the trash is purged, however it is asked.
		unwrap(await purgeTrashed(connectionId, folder.id));
		expect(unwrap(await getFile(connectionId, file.id))).not.toBeNull();
		expect(unwrap(await listUnusedFileBlobs(later, 100)).map((blob) => blob.id)).not.toContain(
			first.blobId,
		);

		unwrap(await trashFile(person, folder.id));
		expect(unwrap(await listTrashedBefore(later, 100))).toContainEqual({
			id: folder.id,
			connectionId,
		});
		unwrap(await purgeTrashed(connectionId, folder.id));

		expect(unwrap(await getFile(connectionId, folder.id))).toBeNull();
		expect(unwrap(await getFile(connectionId, file.id))).toBeNull();
		expect(unwrap(await listFileVersions(connectionId, file.id))).toEqual([]);
		const unused = unwrap(await listUnusedFileBlobs(later, 100)).map((blob) => blob.id);
		expect(unused).toEqual(expect.arrayContaining([first.blobId, second.blobId]));
		// A blob made just now is left alone: its upload may still be on its way.
		expect(
			unwrap(await listUnusedFileBlobs(new Date(Date.now() - 60_000), 100)).map((blob) => blob.id),
		).not.toContain(first.blobId);
		expect(unwrap(await deleteUnusedFileBlob(first.blobId))).toBe(true);
		expect(unwrap(await deleteUnusedFileBlob(first.blobId))).toBe(false);
		// The journal outlives the file: what was done to it is still told.
		expect(await db.fileChange.count({where: {connectionId, fileId: file.id}})).toBe(2);
	});

	test('never forgets a blob a version points at', async () => {
		const held = await content();
		unwrap(await createFile(person, {parentId: null, name: 'held.txt', content: held}));

		expect(unwrap(await deleteUnusedFileBlob(held.blobId))).toBe(false);
	});
});
