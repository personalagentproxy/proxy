import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import type {Result} from 'ts-results-es';

import type {ApiError} from '@proxy/utils';

import {db} from '.';
import {
	completeFileBlob,
	createFile,
	createFileBlob,
	createFolder,
	deleteUnusedFileBlob,
	FILE_CHANGED,
	findFileVersion,
	getFile,
	getFileChange,
	getFileVersion,
	getLatestFileVersion,
	hasTaskCopied,
	listChangedFiles,
	listFileChanges,
	listFileMakers,
	listFileVersions,
	listFolder,
	listTrash,
	listTrashedBefore,
	listUnusedFileBlobs,
	logFileChange,
	moveFile,
	purgeTrashed,
	recordFileVersion,
	restoreFileVersion,
	searchFiles,
	trashFile,
	untrashFile,
	writeFile,
	type FileChangeBy,
	type FileUndo,
	type NewContent,
	type RecordedContent,
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
	// A drive whose files live elsewhere, as Google Drive: an integration of its own, so that what
	// the retention queries find of it is only this test's.
	const elsewhereIntegration = `drive-test-${stamp}`;
	let elsewhereId = '';
	let elsewhere: FileChangeBy;
	let taskId = '';
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

	const SHEET = 'application/vnd.google-apps.spreadsheet';
	const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

	// A Sheet's export copied into the store, as of the drive's revision `revision`.
	async function sheetCopy(revision: string): Promise<RecordedContent> {
		return {...(await content(20, XLSX)), sourceRevision: revision, sourceType: SHEET};
	}

	// A Sheet's revision the drive keeps, with no copy here.
	function sheetRevision(revision: string): RecordedContent {
		return {blobId: null, size: null, type: XLSX, sourceRevision: revision, sourceType: SHEET};
	}

	// Two cells of a tab written, as they were and as the write left them.
	const budgetUndo: FileUndo = {
		kind: 'sheets_cells',
		sheetId: 0,
		tab: 'Budget',
		range: 'B2:C2',
		before: [[{value: 1200}, {formula: '=B2*2'}]],
		after: [[{value: 1500}, null]],
	};

	beforeAll(async () => {
		const user = await db.user.create({
			data: {email: `files-test-${stamp}@example.test`, name: 'Dana'},
		});
		userId = user.id;
		const org = await db.organization.create({
			data: {name: 'Files test', slug: `files-test-${stamp}`, ownerUserId: userId},
		});
		orgId = org.id;
		connectionId = (
			await db.connection.create({
				data: {orgId, integrationId: 'files', ownerUserId: userId, account: 'Files test'},
			})
		).id;
		const task = await db.agentTask.create({
			data: {orgId, agentId: 'agent-1', title: 'Tidy the reports', goal: 'Tidy up', via: 'mcp'},
		});
		person = {orgId, connectionId, by: {userId}};
		agent = {orgId, connectionId, by: {agentId: 'agent-1', taskId: task.id}};
		taskId = task.id;
		const drive = await db.connection.create({
			data: {orgId, integrationId: elsewhereIntegration, account: 'dana@example.com'},
		});
		elsewhereId = drive.id;
		elsewhere = {orgId, connectionId: elsewhereId, by: {agentId: 'agent-1', taskId: task.id}};
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
			await createFile(person, {parentId: null, name: 'roadmap.md', content: await content(1)}),
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

	test('says which agents made what a file holds, each once, the latest first, a persona by its head', async () => {
		const coder = await db.agent.create({
			data: {
				orgId,
				providerId: 'claude',
				name: 'Claude Code',
				username: `files-coder-${stamp}`,
				passwordHash: '-',
			},
		});
		const chat = await db.agent.create({
			data: {
				orgId,
				providerId: 'proxy',
				name: 'Chat',
				username: `files-chat-${stamp}`,
				passwordHash: '-',
			},
		});
		const persona = await db.persona.create({
			data: {orgId, name: 'General', look: '{}', color: 'green'},
		});
		const coding = await db.agentTask.create({
			data: {orgId, agentId: coder.id, title: 'Write the plan', goal: 'Plan', via: 'mcp'},
		});
		const chatting = await db.agentTask.create({
			data: {
				orgId,
				agentId: chat.id,
				personaId: persona.id,
				title: 'Answer',
				goal: 'Answer',
				via: 'harness',
			},
		});
		const byCoder: FileChangeBy = {orgId, connectionId, by: {agentId: coder.id, taskId: coding.id}};
		const byPersona: FileChangeBy = {
			orgId,
			connectionId,
			by: {agentId: chat.id, taskId: chatting.id},
		};
		const file = unwrap(
			await createFile(byCoder, {parentId: null, name: 'launch plan.md', content: await content()}),
		);
		const second = unwrap(
			await writeFile(byPersona, {
				fileId: file.id,
				ifVersion: file.head?.id ?? '',
				content: await content(),
			}),
		);
		const third = unwrap(
			await writeFile(byCoder, {
				fileId: file.id,
				ifVersion: second.head?.id ?? '',
				content: await content(),
			}),
		);
		unwrap(
			await writeFile(person, {
				fileId: file.id,
				ifVersion: third.head?.id ?? '',
				content: await content(),
			}),
		);
		// Renamed by an agent, which made nothing it holds.
		unwrap(await moveFile(agent, {id: file.id, name: 'the launch plan.md'}));
		const mine = unwrap(
			await createFile(person, {parentId: null, name: 'own notes.md', content: await content()}),
		);

		const makers = unwrap(await listFileMakers(connectionId, [file.id, mine.id]));

		expect(makers.get(file.id)).toEqual([
			{kind: 'agent', id: coder.id, name: 'Claude Code', providerId: 'claude'},
			{kind: 'persona', id: persona.id, name: 'General', look: '{}', color: 'green'},
		]);
		expect(makers.get(mine.id)).toBeUndefined();
		// Each version with what the file was called then and who made it, as the makers are.
		expect(
			unwrap(await listFileVersions(connectionId, file.id)).map((version) => [
				version.author?.name,
				version.author?.user?.name ?? version.author?.maker?.name,
				version.author?.task?.title ?? null,
			]),
		).toEqual([
			['launch plan.md', 'Dana', null],
			['launch plan.md', 'Claude Code', 'Write the plan'],
			['launch plan.md', 'General', 'Answer'],
			['launch plan.md', 'Claude Code', 'Write the plan'],
		]);

		// Without its persona, the agent it worked through.
		await db.persona.delete({where: {id: persona.id}});
		expect(
			unwrap(await listFileMakers(connectionId, [file.id]))
				.get(file.id)
				?.map((maker) => maker.name),
		).toEqual(['Claude Code', 'Chat']);
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

	// Slow: each folder of a chain 45 deep is read up to the top as it is made.
	test('moves a folder only where what it holds stays no deeper than anything may be put', async () => {
		// Folders in a chain, `count` deep under `parentId`: each one, the top first.
		async function chain(parentId: string | null, name: string, count: number) {
			const folders = [];
			let under = parentId;
			for (let at = 1; at <= count; at++) {
				const folder = unwrap(await createFolder(person, {parentId: under, name: `${name} ${at}`}));
				folders.push(folder);
				under = folder.id;
			}
			return folders;
		}
		const deep = await chain(null, 'Deep', 45);
		// A folder with four more under it, and a file in the last: five levels under the first.
		const tree = await chain(null, 'Tree', 5);
		const last = tree.at(-1);
		const top = tree[0];
		if (!last || !top) {
			throw new Error('no tree');
		}
		const file = unwrap(
			await createFile(person, {parentId: last.id, name: 'bottom.txt', content: await content()}),
		);

		// The file would be in a folder 50 deep, where nothing may be put.
		expect(refusal(await moveFile(person, {id: top.id, parentId: deep[44]?.id}))).toBe(
			'validation_error: Folders can’t be nested that deep.',
		);
		// A folder higher, it is in one 49 deep, and still opens.
		unwrap(await moveFile(person, {id: top.id, parentId: deep[43]?.id}));
		expect(unwrap(await getFile(connectionId, file.id))?.trail).toHaveLength(49);
		// Renamed where it is, it moves nowhere.
		unwrap(await moveFile(person, {id: top.id, name: 'Tree, renamed'}));
	}, 60_000);

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

	test('records versions of a drive elsewhere’s file by plain ids, a copy or only its revision, once a revision', async () => {
		const fileId = `sheet-${stamp}-1`;
		const first = unwrap(
			await recordFileVersion({connectionId: elsewhereId, fileId, content: await sheetCopy('r1')}),
		);
		// Copied again at the same revision, as a change racing the first would: the first is kept.
		expect(
			unwrap(
				await recordFileVersion({
					connectionId: elsewhereId,
					fileId,
					content: await sheetCopy('r1'),
				}),
			).id,
		).toBe(first.id);
		// A revision the drive keeps only, then pinned, then copied: each keeps more than the one
		// before, and so is a version of its own.
		const kept = unwrap(
			await recordFileVersion({connectionId: elsewhereId, fileId, content: sheetRevision('r2')}),
		);
		const pinned = unwrap(
			await recordFileVersion({
				connectionId: elsewhereId,
				fileId,
				content: {...sheetRevision('r2'), size: 80_000_000, pinned: true},
			}),
		);
		expect(
			unwrap(
				await recordFileVersion({
					connectionId: elsewhereId,
					fileId,
					content: {...sheetRevision('r2'), pinned: true},
				}),
			).id,
		).toBe(pinned.id);
		const copied = unwrap(
			await recordFileVersion({connectionId: elsewhereId, fileId, content: await sheetCopy('r2')}),
		);
		// The one before is no longer the newest: the same revision as an older one is a version.
		expect(
			unwrap(
				await recordFileVersion({connectionId: elsewhereId, fileId, content: sheetRevision('r1')}),
			).id,
		).not.toBe(first.id);

		const versions = unwrap(await listFileVersions(elsewhereId, fileId));
		expect(
			versions.map((version) => [
				version.sourceRevision,
				version.blobId === null,
				version.pinned,
				version.author,
			]),
		).toEqual([
			['r1', true, false, null],
			['r2', false, false, null],
			['r2', true, true, null],
			['r2', true, false, null],
			['r1', false, false, null],
		]);
		expect(versions.slice(1, 4).map((version) => version.id)).toEqual([
			copied.id,
			pinned.id,
			kept.id,
		]);
		const latest = unwrap(await getLatestFileVersion(elsewhereId, fileId));
		expect([latest?.id, latest?.blob]).toEqual([versions[0]?.id, null]);
		expect(unwrap(await getLatestFileVersion(elsewhereId, 'no-such-file'))).toBeNull();
		// One with no copy is no version to read the bytes of, but is found as recorded.
		expect(unwrap(await getFileVersion(elsewhereId, fileId, pinned.id))).toBeNull();
		expect(unwrap(await findFileVersion(elsewhereId, fileId, pinned.id))).toMatchObject({
			size: 80_000_000,
			type: XLSX,
			sourceType: SHEET,
			blob: null,
		});
		expect(unwrap(await getFileVersion(elsewhereId, fileId, copied.id))?.blob.sha256).toStartWith(
			'hash-',
		);
		// Nothing of the tree is made for it.
		expect(unwrap(await getFile(elsewhereId, fileId))).toBeNull();
	});

	test('records a revision copied by many at once a single time', async () => {
		const fileId = `sheet-${stamp}-race`;
		const contents = await Promise.all([1, 2, 3, 4, 5].map(() => sheetCopy('r9')));

		const recorded = await Promise.all(
			contents.map((copy) => recordFileVersion({connectionId: elsewhereId, fileId, content: copy})),
		);

		expect(new Set(recorded.map((result) => unwrap(result).id)).size).toBe(1);
		expect(unwrap(await listFileVersions(elsewhereId, fileId))).toHaveLength(1);
	});

	test('logs changes to a drive elsewhere’s file with the version they made, and knows a task has its copy', async () => {
		const fileId = `sheet-${stamp}-2`;
		const other = await db.agentTask.create({
			data: {orgId, agentId: 'agent-1', title: 'Fill in the budget', goal: 'Fill', via: 'mcp'},
		});
		const byOther: FileChangeBy = {
			orgId,
			connectionId: elsewhereId,
			by: {agentId: 'agent-1', taskId: other.id},
		};
		expect(unwrap(await hasTaskCopied(elsewhereId, fileId, taskId))).toBe(false);
		const copy = unwrap(
			await recordFileVersion({connectionId: elsewhereId, fileId, content: await sheetCopy('r1')}),
		);

		const edit = unwrap(
			await logFileChange(elsewhere, {
				fileId,
				name: 'Budget',
				kind: 'edit',
				beforeVersion: copy.id,
				beforeRevision: 'r1',
				afterRevision: 'r2',
				undo: budgetUndo,
			}),
		);

		expect(edit.version).toBeNull();
		expect(edit.change).toMatchObject({
			kind: 'edit',
			beforeVersion: copy.id,
			afterVersion: null,
			beforeRevision: 'r1',
			afterRevision: 'r2',
			undo: budgetUndo,
			agentId: 'agent-1',
			taskId,
		});
		expect(unwrap(await getFileChange(elsewhereId, edit.change.id))?.undo).toEqual(budgetUndo);
		expect(unwrap(await getFileChange(connectionId, edit.change.id))).toBeNull();
		expect(unwrap(await hasTaskCopied(elsewhereId, fileId, taskId))).toBe(true);
		expect(unwrap(await hasTaskCopied(elsewhereId, fileId, other.id))).toBe(false);
		// A rename by the other task started from no copy, so it has none yet.
		unwrap(
			await logFileChange(byOther, {
				fileId,
				name: 'Budget 2026',
				kind: 'move',
				beforeName: 'Budget',
			}),
		);
		expect(unwrap(await hasTaskCopied(elsewhereId, fileId, other.id))).toBe(false);
		// What a task made needs no copy.
		unwrap(await logFileChange(byOther, {fileId: `${fileId}-new`, name: 'Notes', kind: 'create'}));
		expect(unwrap(await hasTaskCopied(elsewhereId, `${fileId}-new`, other.id))).toBe(true);

		// The copy given back makes a version of the same blob, at the drive's new revision.
		const restore = unwrap(
			await logFileChange(
				{orgId, connectionId: elsewhereId, by: {userId}},
				{
					fileId,
					name: 'Budget 2026',
					kind: 'restore',
					beforeRevision: 'r2',
					afterRevision: 'r3',
					made: {
						blobId: copy.blobId,
						size: copy.size,
						type: copy.type,
						sourceRevision: 'r3',
						sourceType: SHEET,
					},
				},
			),
		);
		expect(restore.change.afterVersion).toBe(restore.version?.id ?? '');
		expect(
			unwrap(await listFileVersions(elsewhereId, fileId)).map((version) => [
				version.sourceRevision,
				version.blobId === copy.blobId,
				version.author?.kind ?? null,
				version.author?.user?.name ?? null,
			]),
		).toEqual([
			['r3', true, 'restore', 'Dana'],
			['r1', true, null, null],
		]);

		// The journal of the file, newest first, each change with who made it and for which task.
		const changes = unwrap(await listFileChanges(elsewhereId, fileId, 10));
		expect(
			changes.map((change) => [
				change.kind,
				change.user?.name ?? null,
				change.task?.title ?? null,
				change.undo?.kind ?? null,
			]),
		).toEqual([
			['restore', 'Dana', null, null],
			['move', null, 'Fill in the budget', null],
			['edit', null, 'Tidy the reports', 'sheets_cells'],
		]);
		expect(
			unwrap(await listFileChanges(elsewhereId, fileId, 1)).map((change) => change.kind),
		).toEqual(['restore']);
	});

	test('lists the files a drive elsewhere has a history of, each by its latest change, the latest first', async () => {
		const drive = await db.connection.create({
			data: {orgId, integrationId: elsewhereIntegration, account: 'lee@example.com'},
		});
		const by: FileChangeBy = {orgId, connectionId: drive.id, by: {userId}};
		expect(unwrap(await listChangedFiles(drive.id, 10))).toEqual([]);
		const log = (fileId: string, name: string, kind: 'create' | 'edit' | 'move') =>
			logFileChange(by, {fileId, name, kind}).then(unwrap);
		await log('plan', 'Plan', 'create');
		await log('budget', 'Budget', 'create');
		await log('plan', 'Launch plan', 'move');
		await log('notes', 'Notes', 'edit');

		expect(
			unwrap(await listChangedFiles(drive.id, 10)).map((change) => [
				change.fileId,
				change.name,
				change.kind,
				change.user?.name ?? null,
			]),
		).toEqual([
			['notes', 'Notes', 'edit', 'Dana'],
			['plan', 'Launch plan', 'move', 'Dana'],
			['budget', 'Budget', 'create', 'Dana'],
		]);
		expect(unwrap(await listChangedFiles(drive.id, 2)).map((change) => change.fileId)).toEqual([
			'notes',
			'plan',
		]);
	});

	test('keeps only an undo it can read, and reads one it doesn’t know as none', async () => {
		const fileId = `sheet-${stamp}-3`;
		const crooked: FileUndo = {...budgetUndo, after: [[{value: 1500}]]};

		expect(
			refusal(
				await logFileChange(elsewhere, {fileId, name: 'Budget', kind: 'edit', undo: crooked}),
			),
		).toBe(
			'validation_error: That change’s undo is not one to keep: The cells before and after are not the same shape.',
		);
		expect(await db.fileChange.count({where: {connectionId: elsewhereId, fileId}})).toBe(0);

		const logged = unwrap(
			await logFileChange(elsewhere, {fileId, name: 'Budget', kind: 'edit', undo: budgetUndo}),
		);
		// As a newer server's kind would be.
		await db.fileChange.update({
			where: {id: logged.change.id},
			data: {undo: {kind: 'docs_text', find: 'Q3'}},
		});
		expect(unwrap(await getFileChange(elsewhereId, logged.change.id))?.undo).toBeNull();
	});
});
