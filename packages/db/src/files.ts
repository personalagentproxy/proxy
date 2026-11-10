import type {FileChangeKind, Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/**
 * Files (schema.prisma FileNode, FileVersion, FileBlob, FileChange): the drives kept in Personal
 * Agent Proxy itself. Three things, kept apart so the last two can serve a drive whose tree lives
 * elsewhere: the tree, a connection's folders and files; the versions, what a file held each time
 * it was written, named by its connection and its id there; and the journal, one row for every
 * change, with who made it. The api's native/files module reads and writes them and owns the
 * bytes; what is checked here is what has to hold whoever asks: a name is its folder's only one
 * outside the trash, a file is overwritten only by whoever read what it holds now, and nothing is
 * written to what is in the trash. Every change takes the connection's row first, so two changes
 * to one drive run one after the other, and is written with its journal row or not at all. What
 * a change refuses is thrown as the api's error, which `wrapDb` hands on as it is.
 */

type Tx = Prisma.TransactionClient;

export type FileNodeRow = {
	id: string;
	connectionId: string;
	parentId: string | null;
	name: string;
	folder: boolean;
	headVersionId: string | null;
	trashedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export type FileVersionRow = {
	id: string;
	connectionId: string;
	fileId: string;
	blobId: string;
	size: number;
	type: string;
	createdAt: Date;
};

export type FileBlobRow = {
	id: string;
	orgId: string;
	backendId: string;
	key: string;
	size: number;
	sha256: string | null;
};

/** A file or folder as a list shows it: a file with what it holds now. */
export type FileEntry = FileNodeRow & {head: FileVersionRow | null};

/** A file or folder opened: where it is, the folders above it from the top down, and whether it is in the trash, by itself or with a folder above it. */
export type FileFound = FileEntry & {trail: FileNodeRow[]; trashed: boolean};

/** Who makes a change: a member, or an agent for one of its tasks. */
export type FileActor = {userId: string} | {agentId: string; taskId: string};

/** The drive a change is made in, and who makes it. */
export type FileChangeBy = {orgId: string; connectionId: string; by: FileActor};

export type {FileChangeKind};

const nodeSelect = {
	id: true,
	connectionId: true,
	parentId: true,
	name: true,
	folder: true,
	headVersionId: true,
	trashedAt: true,
	createdAt: true,
	updatedAt: true,
} as const;
const versionSelect = {
	id: true,
	connectionId: true,
	fileId: true,
	blobId: true,
	size: true,
	type: true,
	createdAt: true,
} as const;
const blobSelect = {
	id: true,
	orgId: true,
	backendId: true,
	key: true,
	size: true,
	sha256: true,
} as const;

// How deep a folder may be, so a walk up the tree always ends.
const MAX_DEPTH = 50;

/** What a write is told when the file moved on since it was read. */
export const FILE_CHANGED =
	'The file changed since that version was read. Read it again, then write.';

function nameTaken(name: string): ApiError {
	return ApiErr.conflict(`Something is already called ${name} there.`);
}

function lockDrive(tx: Tx, connectionId: string): Promise<unknown> {
	return tx.$queryRaw`SELECT "id" FROM "Connection" WHERE "id" = ${connectionId} FOR UPDATE`;
}

// The folders above a place, from the top down, the folder itself last; none for the top. Thrown
// as not found where the folder isn't one of the drive's.
async function trailOf(
	client: Tx,
	connectionId: string,
	folderId: string | null,
): Promise<FileNodeRow[]> {
	const trail: FileNodeRow[] = [];
	let next = folderId;
	while (next !== null) {
		const folder: FileNodeRow | null = await client.fileNode.findFirst({
			where: {id: next, connectionId, folder: true},
			select: nodeSelect,
		});
		if (!folder || trail.length >= MAX_DEPTH) {
			throw ApiErr.notFound('folder', next);
		}
		trail.unshift(folder);
		next = folder.parentId;
	}
	return trail;
}

// A folder to put something in: one of the drive's, outside the trash; the top is always one.
async function requireOpenFolder(
	tx: Tx,
	connectionId: string,
	folderId: string | null,
): Promise<FileNodeRow[]> {
	const trail = await trailOf(tx, connectionId, folderId);
	if (trail.some((folder) => folder.trashedAt !== null)) {
		throw ApiErr.notFound('folder', folderId ?? undefined, 'That folder is in the trash.');
	}
	if (trail.length >= MAX_DEPTH) {
		throw ApiErr.validationError('Folders can’t be nested that deep.');
	}
	return trail;
}

// A file or folder to change: one of the drive's, outside the trash.
async function requireLive(tx: Tx, connectionId: string, id: string): Promise<FileNodeRow> {
	const node = await tx.fileNode.findFirst({where: {id, connectionId}, select: nodeSelect});
	if (!node) {
		throw ApiErr.notFound('file', id);
	}
	const trail = await trailOf(tx, connectionId, node.parentId);
	if (node.trashedAt !== null || trail.some((folder) => folder.trashedAt !== null)) {
		throw ApiErr.notFound('file', id, 'It is in the trash.');
	}
	return node;
}

async function isTaken(
	tx: Tx,
	connectionId: string,
	parentId: string | null,
	name: string,
	except?: string,
): Promise<boolean> {
	const found = await tx.fileNode.findFirst({
		where: {
			connectionId,
			parentId,
			name,
			trashedAt: null,
			...(except === undefined ? {} : {id: {not: except}}),
		},
		select: {id: true},
	});
	return found !== null;
}

// "report.pdf" as "report (2).pdf", the first such name the folder has free.
async function freeName(
	tx: Tx,
	connectionId: string,
	parentId: string | null,
	name: string,
): Promise<string> {
	if (!(await isTaken(tx, connectionId, parentId, name))) {
		return name;
	}
	const dot = name.lastIndexOf('.');
	const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	for (let number = 2; number < 1000; number += 1) {
		const candidate = `${stem} (${number})${extension}`;
		if (!(await isTaken(tx, connectionId, parentId, candidate))) {
			return candidate;
		}
	}
	throw nameTaken(name);
}

function actorColumns(by: FileActor): {
	userId: string | null;
	agentId: string | null;
	taskId: string | null;
} {
	if ('userId' in by) {
		return {userId: by.userId, agentId: null, taskId: null};
	}
	return {userId: null, agentId: by.agentId, taskId: by.taskId};
}

type Journaled = {
	fileId: string;
	name: string;
	kind: FileChangeKind;
	beforeVersion?: string | null;
	afterVersion?: string | null;
	beforeParentId?: string | null;
	beforeName?: string | null;
};

function journal(tx: Tx, change: FileChangeBy, entry: Journaled): Promise<unknown> {
	return tx.fileChange.create({
		data: {
			orgId: change.orgId,
			connectionId: change.connectionId,
			...entry,
			...actorColumns(change.by),
		},
		select: {id: true},
	});
}

async function withHeads(client: Tx, nodes: FileNodeRow[]): Promise<FileEntry[]> {
	const ids = nodes.flatMap((node) => (node.headVersionId === null ? [] : [node.headVersionId]));
	const versions =
		ids.length === 0
			? []
			: await client.fileVersion.findMany({where: {id: {in: ids}}, select: versionSelect});
	const byId = new Map(versions.map((version) => [version.id, version]));
	return nodes.map((node) => ({
		...node,
		head: (node.headVersionId && byId.get(node.headVersionId)) || null,
	}));
}

/** A file or folder of the drive with where it is, in the trash or not; `Ok(null)` for none. */
export function getFile(
	connectionId: string,
	id: string,
): Promise<Result<FileFound | null, ApiError>> {
	return wrapDb(async () => {
		const node = await db.fileNode.findFirst({where: {id, connectionId}, select: nodeSelect});
		if (!node) {
			return null;
		}
		const trail = await trailOf(db, connectionId, node.parentId);
		const [entry] = await withHeads(db, [node]);
		if (!entry) {
			return null;
		}
		return {
			...entry,
			trail,
			trashed: node.trashedAt !== null || trail.some((folder) => folder.trashedAt !== null),
		};
	});
}

/** What a folder holds outside the trash, the top's for null: folders first, then by name. The folder itself is the caller's to have found. */
export function listFolder(
	connectionId: string,
	parentId: string | null,
): Promise<Result<FileEntry[], ApiError>> {
	return wrapDb(async () => {
		const nodes = await db.fileNode.findMany({
			where: {connectionId, parentId, trashedAt: null},
			select: nodeSelect,
			orderBy: [{folder: 'desc'}, {name: 'asc'}],
		});
		return withHeads(db, nodes);
	});
}

// How many of a search's matches are answered at most.
const MAX_FOUND = 100;

/**
 * The files and folders outside the trash whose name has `search`, in any case, anywhere in the
 * drive or inside `within`, each with where it is; at most a hundred, by name.
 */
export function searchFiles(
	connectionId: string,
	search: string,
	within: string | null,
): Promise<Result<FileFound[], ApiError>> {
	return wrapDb(async () => {
		const [matches, folders] = await Promise.all([
			db.fileNode.findMany({
				where: {connectionId, trashedAt: null, name: {contains: search, mode: 'insensitive'}},
				select: nodeSelect,
				orderBy: {name: 'asc'},
			}),
			db.fileNode.findMany({where: {connectionId, folder: true}, select: nodeSelect}),
		]);
		const byId = new Map(folders.map((folder) => [folder.id, folder]));
		const trailFor = (node: FileNodeRow): FileNodeRow[] | null => {
			const trail: FileNodeRow[] = [];
			let next = node.parentId;
			while (next !== null) {
				const folder = byId.get(next);
				if (!folder || folder.trashedAt !== null || trail.length >= MAX_DEPTH) {
					return null;
				}
				trail.unshift(folder);
				next = folder.parentId;
			}
			return trail;
		};
		const found = matches.flatMap((node) => {
			const trail = trailFor(node);
			if (trail === null || (within !== null && !trail.some((folder) => folder.id === within))) {
				return [];
			}
			return [{node, trail}];
		});
		const kept = found.slice(0, MAX_FOUND);
		const entries = await withHeads(
			db,
			kept.map(({node}) => node),
		);
		return entries.map((entry, index) => ({
			...entry,
			trail: kept[index]?.trail ?? [],
			trashed: false,
		}));
	});
}

/** What was put in the trash, each by itself, last trashed first, with where it was. */
export function listTrash(connectionId: string): Promise<Result<FileFound[], ApiError>> {
	return wrapDb(async () => {
		const nodes = await db.fileNode.findMany({
			where: {connectionId, trashedAt: {not: null}},
			select: nodeSelect,
			orderBy: {trashedAt: 'desc'},
		});
		const entries = await withHeads(db, nodes);
		const found: FileFound[] = [];
		for (const entry of entries) {
			found.push({...entry, trail: await trailOf(db, connectionId, entry.parentId), trashed: true});
		}
		return found;
	});
}

/** A new, empty folder called `name` in `parentId`, the top for null; a conflict where the name is taken. */
export function createFolder(
	change: FileChangeBy,
	data: {parentId: string | null; name: string},
): Promise<Result<FileNodeRow, ApiError>> {
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			await requireOpenFolder(tx, connectionId, data.parentId);
			if (await isTaken(tx, connectionId, data.parentId, data.name)) {
				throw nameTaken(data.name);
			}
			const folder = await tx.fileNode.create({
				data: {connectionId, parentId: data.parentId, name: data.name, folder: true},
				select: nodeSelect,
			});
			await journal(tx, change, {fileId: folder.id, name: folder.name, kind: 'create'});
			return folder;
		}),
	);
}

/** The folder called `name` in `parentId`, made where there is none; a conflict where a file has the name. */
export function ensureFolder(
	change: FileChangeBy,
	data: {parentId: string | null; name: string},
): Promise<Result<FileNodeRow, ApiError>> {
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			await requireOpenFolder(tx, connectionId, data.parentId);
			const found = await tx.fileNode.findFirst({
				where: {connectionId, parentId: data.parentId, name: data.name, trashedAt: null},
				select: nodeSelect,
			});
			if (found?.folder) {
				return found;
			}
			if (found) {
				throw nameTaken(data.name);
			}
			const folder = await tx.fileNode.create({
				data: {connectionId, parentId: data.parentId, name: data.name, folder: true},
				select: nodeSelect,
			});
			await journal(tx, change, {fileId: folder.id, name: folder.name, kind: 'create'});
			return folder;
		}),
	);
}

/** What a new version holds: the blob with its bytes, already in the store, and what they are. */
export type NewContent = {blobId: string; size: number; type: string};

/**
 * A new file called `name` in `parentId`, holding `content` as its first version. Where the name
 * is taken: a conflict, or, with `rename`, the first free name like it, as `report (2).pdf`.
 */
export function createFile(
	change: FileChangeBy,
	data: {parentId: string | null; name: string; content: NewContent; rename?: boolean},
): Promise<Result<FileEntry, ApiError>> {
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			await requireOpenFolder(tx, connectionId, data.parentId);
			const name = data.rename
				? await freeName(tx, connectionId, data.parentId, data.name)
				: data.name;
			if (!data.rename && (await isTaken(tx, connectionId, data.parentId, name))) {
				throw nameTaken(name);
			}
			const made = await tx.fileNode.create({
				data: {connectionId, parentId: data.parentId, name},
				select: nodeSelect,
			});
			const head = await tx.fileVersion.create({
				data: {connectionId, fileId: made.id, ...data.content},
				select: versionSelect,
			});
			const node = await tx.fileNode.update({
				where: {id: made.id},
				data: {headVersionId: head.id},
				select: nodeSelect,
			});
			await journal(tx, change, {fileId: node.id, name, kind: 'create', afterVersion: head.id});
			return {...node, head};
		}),
	);
}

/**
 * A file's content written over, as its next version, by whoever read `ifVersion`: a conflict
 * (`FILE_CHANGED`) where the file holds another by now. The version before stays in its history.
 */
export function writeFile(
	change: FileChangeBy,
	data: {fileId: string; ifVersion: string; content: NewContent},
): Promise<Result<FileEntry, ApiError>> {
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			const node = await requireLive(tx, connectionId, data.fileId);
			if (node.folder) {
				throw ApiErr.validationError('A folder has no content to write.');
			}
			if (node.headVersionId !== data.ifVersion) {
				throw ApiErr.conflict(FILE_CHANGED);
			}
			const head = await tx.fileVersion.create({
				data: {connectionId, fileId: node.id, ...data.content},
				select: versionSelect,
			});
			const written = await tx.fileNode.update({
				where: {id: node.id},
				data: {headVersionId: head.id},
				select: nodeSelect,
			});
			await journal(tx, change, {
				fileId: node.id,
				name: node.name,
				kind: 'write',
				beforeVersion: node.headVersionId,
				afterVersion: head.id,
			});
			return {...written, head};
		}),
	);
}

/**
 * An earlier version given back: the file's next version, holding what `versionId` held, so
 * nothing of its history is lost. The version it holds already changes nothing.
 */
export function restoreFileVersion(
	change: FileChangeBy,
	data: {fileId: string; versionId: string},
): Promise<Result<FileEntry, ApiError>> {
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			const node = await requireLive(tx, connectionId, data.fileId);
			const earlier = await tx.fileVersion.findFirst({
				where: {id: data.versionId, connectionId, fileId: node.id},
				select: versionSelect,
			});
			if (!earlier) {
				throw ApiErr.notFound('version', data.versionId);
			}
			if (node.headVersionId === earlier.id) {
				return {...node, head: earlier};
			}
			const head = await tx.fileVersion.create({
				data: {
					connectionId,
					fileId: node.id,
					blobId: earlier.blobId,
					size: earlier.size,
					type: earlier.type,
				},
				select: versionSelect,
			});
			const restored = await tx.fileNode.update({
				where: {id: node.id},
				data: {headVersionId: head.id},
				select: nodeSelect,
			});
			await journal(tx, change, {
				fileId: node.id,
				name: node.name,
				kind: 'restore',
				beforeVersion: node.headVersionId,
				afterVersion: head.id,
			});
			return {...restored, head};
		}),
	);
}

/**
 * A file or folder renamed, moved to another folder, or both: `name` and `parentId` each as they
 * are to be, left out to stay. A conflict where the name is taken there; a folder never goes
 * inside itself.
 */
export function moveFile(
	change: FileChangeBy,
	data: {id: string; name?: string; parentId?: string | null},
): Promise<Result<FileNodeRow, ApiError>> {
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			const node = await requireLive(tx, connectionId, data.id);
			const name = data.name ?? node.name;
			const parentId = data.parentId === undefined ? node.parentId : data.parentId;
			if (name === node.name && parentId === node.parentId) {
				return node;
			}
			const trail = await requireOpenFolder(tx, connectionId, parentId);
			if (trail.some((folder) => folder.id === node.id)) {
				throw ApiErr.validationError('A folder can’t be moved inside itself.');
			}
			if (await isTaken(tx, connectionId, parentId, name, node.id)) {
				throw nameTaken(name);
			}
			const moved = await tx.fileNode.update({
				where: {id: node.id},
				data: {name, parentId},
				select: nodeSelect,
			});
			await journal(tx, change, {
				fileId: node.id,
				name,
				kind: 'move',
				beforeParentId: node.parentId,
				beforeName: node.name,
			});
			return moved;
		}),
	);
}

/** A file or folder put in the trash, a folder with everything inside it, to be taken out again or purged later. */
export function trashFile(
	change: FileChangeBy,
	id: string,
): Promise<Result<FileNodeRow, ApiError>> {
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			const node = await requireLive(tx, connectionId, id);
			const trashed = await tx.fileNode.update({
				where: {id: node.id},
				data: {trashedAt: new Date()},
				select: nodeSelect,
			});
			await journal(tx, change, {
				fileId: node.id,
				name: node.name,
				kind: 'trash',
				beforeVersion: node.headVersionId,
				afterVersion: node.headVersionId,
			});
			return trashed;
		}),
	);
}

/**
 * What was put in the trash taken out, back where it was: a conflict where its folder is still in
 * the trash, or its name was taken there meanwhile.
 */
export function untrashFile(
	change: FileChangeBy,
	id: string,
): Promise<Result<FileNodeRow, ApiError>> {
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			const node = await tx.fileNode.findFirst({
				where: {id, connectionId, trashedAt: {not: null}},
				select: nodeSelect,
			});
			if (!node) {
				throw ApiErr.notFound('file', id, 'Nothing by that id is in the trash.');
			}
			const trail = await trailOf(tx, connectionId, node.parentId);
			if (trail.some((folder) => folder.trashedAt !== null)) {
				throw ApiErr.conflict('The folder it was in is in the trash too: take that out first.');
			}
			if (await isTaken(tx, connectionId, node.parentId, node.name)) {
				throw ApiErr.conflict(
					`Something else is called ${node.name} there now: rename that first.`,
				);
			}
			const back = await tx.fileNode.update({
				where: {id: node.id},
				data: {trashedAt: null},
				select: nodeSelect,
			});
			await journal(tx, change, {
				fileId: node.id,
				name: node.name,
				kind: 'untrash',
				beforeVersion: node.headVersionId,
				afterVersion: node.headVersionId,
			});
			return back;
		}),
	);
}

/** Who made a version, as far as the journal has it: the member, or the agent and the task it was for. */
export type VersionAuthor = {
	kind: FileChangeKind;
	user: {name: string | null; email: string} | null;
	agent: {id: string; name: string} | null;
	task: {id: string; title: string} | null;
	personaName: string | null;
};

export type FileVersionEntry = FileVersionRow & {author: VersionAuthor | null};

/** A file's versions, newest first, each with who made it. */
export function listFileVersions(
	connectionId: string,
	fileId: string,
): Promise<Result<FileVersionEntry[], ApiError>> {
	return wrapDb(async () => {
		const versions = await db.fileVersion.findMany({
			where: {connectionId, fileId},
			select: versionSelect,
			orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
		});
		const changes = await db.fileChange.findMany({
			where: {
				connectionId,
				fileId,
				afterVersion: {in: versions.map((version) => version.id)},
				kind: {in: ['create', 'write', 'restore']},
			},
			select: {kind: true, afterVersion: true, userId: true, agentId: true, taskId: true},
		});
		const ids = <K extends 'userId' | 'agentId' | 'taskId'>(key: K) => [
			...new Set(changes.flatMap((change) => (change[key] === null ? [] : [change[key]]))),
		];
		const [users, agents, tasks] = await Promise.all([
			db.user.findMany({
				where: {id: {in: ids('userId')}},
				select: {id: true, name: true, email: true},
			}),
			db.agent.findMany({where: {id: {in: ids('agentId')}}, select: {id: true, name: true}}),
			db.agentTask.findMany({
				where: {id: {in: ids('taskId')}},
				select: {id: true, title: true, personaId: true},
			}),
		]);
		const personaIds = [
			...new Set(tasks.flatMap((task) => (task.personaId === null ? [] : [task.personaId]))),
		];
		const personas =
			personaIds.length === 0
				? []
				: await db.persona.findMany({
						where: {id: {in: personaIds}},
						select: {id: true, name: true},
					});
		return versions.map((version) => {
			const change = changes.find((candidate) => candidate.afterVersion === version.id);
			if (!change) {
				return {...version, author: null};
			}
			const user = users.find((candidate) => candidate.id === change.userId);
			const agent = agents.find((candidate) => candidate.id === change.agentId);
			const task = tasks.find((candidate) => candidate.id === change.taskId);
			const persona = personas.find((candidate) => candidate.id === task?.personaId);
			return {
				...version,
				author: {
					kind: change.kind,
					user: user ? {name: user.name, email: user.email} : null,
					agent: agent ?? null,
					task: task ? {id: task.id, title: task.title} : null,
					personaName: persona?.name ?? null,
				},
			};
		});
	});
}

/** One of a file's versions with the blob that has its bytes; `Ok(null)` for none. */
export function getFileVersion(
	connectionId: string,
	fileId: string,
	versionId: string,
): Promise<Result<(FileVersionRow & {blob: FileBlobRow}) | null, ApiError>> {
	return wrapDb(() =>
		db.fileVersion.findFirst({
			where: {id: versionId, connectionId, fileId},
			select: {...versionSelect, blob: {select: blobSelect}},
		}),
	);
}

/** A blob's row, made before its bytes are sent to the store under `key`. */
export function createFileBlob(data: {
	orgId: string;
	backendId: string;
	key: string;
}): Promise<Result<FileBlobRow, ApiError>> {
	return wrapDb(() => db.fileBlob.create({data, select: blobSelect}));
}

/** A blob whose bytes are all in the store: how many, and their SHA-256. */
export function completeFileBlob(
	id: string,
	data: {size: number; sha256: string},
): Promise<Result<FileBlobRow, ApiError>> {
	return wrapDb(() => db.fileBlob.update({where: {id}, data, select: blobSelect}));
}

/** The blobs made before `before` that no version points at: uploads given up, and what their drive or the trash's purge left. */
export function listUnusedFileBlobs(
	before: Date,
	limit: number,
): Promise<Result<FileBlobRow[], ApiError>> {
	return wrapDb(() =>
		db.fileBlob.findMany({
			where: {createdAt: {lt: before}, versions: {none: {}}},
			select: blobSelect,
			orderBy: {createdAt: 'asc'},
			take: limit,
		}),
	);
}

/** Forgets a blob no version points at, once its bytes are out of the store; whether it did. */
export function deleteUnusedFileBlob(id: string): Promise<Result<boolean, ApiError>> {
	return wrapDb(async () => {
		const {count} = await db.fileBlob.deleteMany({where: {id, versions: {none: {}}}});
		return count > 0;
	});
}

/** What has been in the trash since before `before`, each by itself, oldest first. */
export function listTrashedBefore(
	before: Date,
	limit: number,
): Promise<Result<Array<{id: string; connectionId: string}>, ApiError>> {
	return wrapDb(() =>
		db.fileNode.findMany({
			where: {trashedAt: {lt: before}},
			select: {id: true, connectionId: true},
			orderBy: {trashedAt: 'asc'},
			take: limit,
		}),
	);
}

/**
 * Deletes what is in the trash for good: the file or folder, everything inside it, and their
 * versions. The blobs are the sweep's to remove once nothing points at them. Nothing where it is
 * no longer in the trash.
 */
export function purgeTrashed(connectionId: string, id: string): Promise<Result<void, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockDrive(tx, connectionId);
			const root = await tx.fileNode.findFirst({
				where: {id, connectionId, trashedAt: {not: null}},
				select: {id: true},
			});
			if (!root) {
				return;
			}
			const ids = [root.id];
			let level = [root.id];
			while (level.length > 0) {
				const children = await tx.fileNode.findMany({
					where: {connectionId, parentId: {in: level}},
					select: {id: true},
				});
				level = children.map((child) => child.id);
				ids.push(...level);
			}
			await tx.fileVersion.deleteMany({where: {connectionId, fileId: {in: ids}}});
			await tx.fileNode.deleteMany({where: {connectionId, id: {in: ids}}});
		}),
	);
}

/** The member's own drive in an organization, by its connection's id; `Ok(null)` where they have none yet. */
export function getOwnDrive(data: {
	orgId: string;
	userId: string;
	integrationId: string;
}): Promise<Result<string | null, ApiError>> {
	const {orgId, userId, integrationId} = data;
	return wrapDb(async () => {
		const found = await db.connection.findFirst({
			where: {orgId, integrationId, ownerUserId: userId, name: null},
			select: {id: true},
			orderBy: {createdAt: 'asc'},
		});
		return found?.id ?? null;
	});
}

/**
 * The member's own Files connection in an organization, made where they have none, with
 * `defaults` and called by the organization's name, as their vault is. Once however many ask at
 * once: the second finds the first's.
 */
export function createMissingFilesConnection(data: {
	orgId: string;
	userId: string;
	integrationId: string;
	defaults: string[];
}): Promise<Result<void, ApiError>> {
	const {orgId, userId, integrationId, defaults} = data;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const locked = await tx.$queryRaw<
				Array<{name: string}>
			>`SELECT "name" FROM "Organization" WHERE "id" = ${orgId} FOR UPDATE`;
			const [org] = locked;
			if (!org) {
				return;
			}
			const found = await tx.connection.findFirst({
				where: {orgId, integrationId, ownerUserId: userId, name: null},
				select: {id: true},
			});
			if (found) {
				return;
			}
			await tx.connection.create({
				data: {
					orgId,
					ownerUserId: userId,
					integrationId,
					account: org.name,
					defaults: {create: defaults.map((actionId) => ({actionId}))},
				},
			});
		}),
	);
}
