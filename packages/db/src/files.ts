import type {FileChangeKind, Prisma} from '@prisma/client';
import type {Result} from 'ts-results-es';

import {ApiErr, type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';
import {type FileUndo, fileUndoSchema, parseFileUndo} from './file-undo';

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
 *
 * A drive whose tree lives elsewhere, as Google Drive, keeps only versions and the journal here,
 * by plain ids (`recordFileVersion`, `logFileChange`): its file is changed there, and what is
 * recorded here takes a lock on that one file, not the drive. Its version may be a copy in the blob
 * store, or only the drive's own revision with no blob; a file of Files always has its bytes here.
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
	blobId: string | null;
	size: number | null;
	type: string;
	sourceRevision: string | null;
	sourceType: string | null;
	pinned: boolean;
	createdAt: Date;
};

/** A version with its bytes in the blob store, as every version of a file of Files is. */
export type StoredVersionRow = FileVersionRow & {blobId: string; size: number};

export type FileBlobRow = {
	id: string;
	orgId: string;
	backendId: string;
	key: string;
	size: number;
	sha256: string | null;
	/** The agent whose blob it is, the only one that may use it (api blobs/); none for a person's. */
	agentId: string | null;
	/** The file's name and media type, where its source had them. */
	name: string | null;
	type: string | null;
	createdAt: Date;
};

/** A file or folder as a list shows it: a file with what it holds now. */
export type FileEntry = FileNodeRow & {head: StoredVersionRow | null};

/** A file or folder opened: where it is, the folders above it from the top down, and whether it is in the trash, by itself or with a folder above it. */
export type FileFound = FileEntry & {trail: FileNodeRow[]; trashed: boolean};

/** Who makes a change: a member, or an agent for one of its tasks. */
export type FileActor = {userId: string} | {agentId: string; taskId: string};

/** The drive a change is made in, and who makes it. */
export type FileChangeBy = {orgId: string; connectionId: string; by: FileActor};

export type {FileChangeKind, FileUndo};

/** One change of the journal, its inverse read as one this server knows, or null. */
export type FileChangeRow = {
	id: string;
	orgId: string;
	connectionId: string;
	fileId: string;
	name: string;
	kind: FileChangeKind;
	beforeVersion: string | null;
	afterVersion: string | null;
	beforeRevision: string | null;
	afterRevision: string | null;
	beforeParentId: string | null;
	beforeName: string | null;
	undo: FileUndo | null;
	userId: string | null;
	agentId: string | null;
	taskId: string | null;
	createdAt: Date;
};

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
	sourceRevision: true,
	sourceType: true,
	pinned: true,
	createdAt: true,
} as const;
const blobSelect = {
	id: true,
	orgId: true,
	backendId: true,
	key: true,
	size: true,
	sha256: true,
	agentId: true,
	name: true,
	type: true,
	createdAt: true,
} as const;

// How deep a folder may be, so a walk up the tree always ends.
const MAX_DEPTH = 50;

/** What a write is told when the file moved on since it was read. */
export const FILE_CHANGED =
	'The file changed since that version was read. Read it again, then write.';

function nameTaken(name: string): ApiError {
	return ApiErr.conflict(`Something is already called ${name} there.`);
}

async function lockDrive(tx: Tx, connectionId: string): Promise<void> {
	await tx.$queryRaw`SELECT "id" FROM "Connection" WHERE "id" = ${connectionId} FOR UPDATE`;
}

// One file of a drive elsewhere, held until the transaction ends, so that what is recorded of it
// is recorded one after the other: a lock on a key made of its connection's and its own id, as the
// file has no row here to take.
async function lockFile(tx: Tx, connectionId: string, fileId: string): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`file:${connectionId}:${fileId}`}::text, 0))`;
}

/** Whether a version has its bytes in the blob store, as every one of a file of Files does. */
export function isStored<V extends FileVersionRow>(
	version: V,
): version is V & {blobId: string; size: number} {
	return version.blobId !== null && version.size !== null;
}

// A version of a file of Files, which always has its bytes in the store: thrown as the server's
// error where one has none.
function stored<V extends FileVersionRow>(version: V): V & {blobId: string; size: number} {
	if (!isStored(version)) {
		throw ApiErr.internalError(new Error(`Version ${version.id} of a file of Files has no bytes.`));
	}
	return version;
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

// The folders above each of `nodes`, read a level at a time for all of them at once rather than
// a query a folder for each, by id.
async function foldersAbove(
	client: Tx,
	connectionId: string,
	nodes: FileNodeRow[],
): Promise<Map<string, FileNodeRow>> {
	const byId = new Map<string, FileNodeRow>();
	let wanted = new Set(nodes.flatMap((node) => (node.parentId === null ? [] : [node.parentId])));
	for (let level = 0; wanted.size > 0 && level <= MAX_DEPTH; level++) {
		const folders = await client.fileNode.findMany({
			where: {connectionId, folder: true, id: {in: [...wanted]}},
			select: nodeSelect,
		});
		for (const folder of folders) {
			byId.set(folder.id, folder);
		}
		wanted = new Set(
			folders.flatMap((folder) =>
				folder.parentId === null || byId.has(folder.parentId) ? [] : [folder.parentId],
			),
		);
	}
	return byId;
}

// The folders from the drive's top down to `folderId`, out of those `foldersAbove` read; null
// where one is missing among them or the path is deeper than a drive goes.
function trailIn(byId: Map<string, FileNodeRow>, folderId: string | null): FileNodeRow[] | null {
	const trail: FileNodeRow[] = [];
	let next = folderId;
	while (next !== null) {
		const folder = byId.get(next);
		if (!folder || trail.length >= MAX_DEPTH) {
			return null;
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

// How many levels of files and folders there are under a folder, in the trash or not: none for
// an empty one, or a file. Counted no deeper than a drive goes.
async function levelsBelow(tx: Tx, connectionId: string, id: string): Promise<number> {
	let levels = 0;
	let level = [id];
	while (levels <= MAX_DEPTH) {
		const children = await tx.fileNode.findMany({
			where: {connectionId, parentId: {in: level}},
			select: {id: true},
		});
		if (children.length === 0) {
			return levels;
		}
		levels += 1;
		level = children.map((child) => child.id);
	}
	return levels;
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

/** What a change was, as the journal keeps it; what is left out is null. */
export type Journaled = {
	fileId: string;
	/** The file's name, after the change. */
	name: string;
	kind: FileChangeKind;
	beforeVersion?: string | null;
	afterVersion?: string | null;
	/** A drive elsewhere's own revisions of the file, just before and just after the change. */
	beforeRevision?: string | null;
	afterRevision?: string | null;
	beforeParentId?: string | null;
	beforeName?: string | null;
	/** The change's exact inverse, where it has one. */
	undo?: FileUndo | null;
};

const changeSelect = {
	id: true,
	orgId: true,
	connectionId: true,
	fileId: true,
	name: true,
	kind: true,
	beforeVersion: true,
	afterVersion: true,
	beforeRevision: true,
	afterRevision: true,
	beforeParentId: true,
	beforeName: true,
	undo: true,
	userId: true,
	agentId: true,
	taskId: true,
	createdAt: true,
} as const;

function changeRow(row: Prisma.FileChangeGetPayload<{select: typeof changeSelect}>): FileChangeRow {
	return {...row, undo: parseFileUndo(row.undo)};
}

async function journal(tx: Tx, change: FileChangeBy, entry: Journaled): Promise<FileChangeRow> {
	const {undo, ...rest} = entry;
	// An inverse is checked as it will be read, so none is kept that could never be applied.
	const checked = undo ? fileUndoSchema.safeParse(undo) : null;
	if (checked && !checked.success) {
		const why = checked.error.issues.map((issue) => issue.message).join(' ');
		throw ApiErr.validationError(`That change’s undo is not one to keep: ${why}`);
	}
	const row = await tx.fileChange.create({
		data: {
			orgId: change.orgId,
			connectionId: change.connectionId,
			...rest,
			...(checked ? {undo: checked.data} : {}),
			...actorColumns(change.by),
		},
		select: changeSelect,
	});
	return changeRow(row);
}

/** What a version holds, as a drive elsewhere records it: a copy in the store, or none, and the drive's own revision and type. */
export type RecordedContent = {
	/** The copy's blob and its size; null for a version kept only in the drive. */
	blobId: string | null;
	size: number | null;
	/** The media type of the bytes: the copy's, or else the revision's in the drive. */
	type: string;
	sourceRevision: string | null;
	sourceType: string | null;
	/** Whether the revision was pinned in the drive, to be released later. */
	pinned?: boolean;
};

async function insertVersion(
	tx: Tx,
	connectionId: string,
	fileId: string,
	content: RecordedContent,
): Promise<FileVersionRow> {
	return tx.fileVersion.create({
		data: {connectionId, fileId, ...content},
		select: versionSelect,
	});
}

/** A version with the blob that has its bytes, where it has one. */
export type FileVersionFound = FileVersionRow & {blob: FileBlobRow | null};

// The newest of a file's versions, with its blob where it has one.
function latestVersion(
	client: Tx,
	connectionId: string,
	fileId: string,
): Promise<FileVersionFound | null> {
	return client.fileVersion.findFirst({
		where: {connectionId, fileId},
		select: {...versionSelect, blob: {select: blobSelect}},
		orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
	});
}

// Whether `latest` already holds what `content` would: the same revision of the drive, kept at
// least as well, with a copy where `content` has one and pinned where it is pinned, so a pin made
// is never left unrecorded.
function holdsAlready(latest: FileVersionRow, content: RecordedContent): boolean {
	if (content.sourceRevision === null || latest.sourceRevision !== content.sourceRevision) {
		return false;
	}
	if (content.blobId !== null && latest.blobId === null) {
		return false;
	}
	return !content.pinned || latest.pinned;
}

async function withHeads(client: Tx, nodes: FileNodeRow[]): Promise<FileEntry[]> {
	const ids = nodes.flatMap((node) => (node.headVersionId === null ? [] : [node.headVersionId]));
	const versions =
		ids.length === 0
			? []
			: await client.fileVersion.findMany({where: {id: {in: ids}}, select: versionSelect});
	const byId = new Map(versions.map((version) => [version.id, stored(version)]));
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

/**
 * A path walked from the drive's top, a name at a time, outside the trash: the folders and the
 * file found along it, in order, and the names left where it ends before the path does, as it
 * does at a name nothing there has, or at a file with names still to go.
 */
export function findPath(
	connectionId: string,
	names: string[],
): Promise<Result<{found: FileEntry[]; missing: string[]}, ApiError>> {
	return wrapDb(async () => {
		const found: FileNodeRow[] = [];
		let parentId: string | null = null;
		for (const [index, name] of names.entries()) {
			const node: FileNodeRow | null = await db.fileNode.findFirst({
				where: {connectionId, parentId, name, trashedAt: null},
				select: nodeSelect,
			});
			if (!node) {
				return {found: await withHeads(db, found), missing: names.slice(index)};
			}
			found.push(node);
			if (!node.folder) {
				return {found: await withHeads(db, found), missing: names.slice(index + 1)};
			}
			parentId = node.id;
		}
		return {found: await withHeads(db, found), missing: []};
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
		// Read a page of matches at a time, as many as are kept at most twice over, until enough
		// of them are outside the trash and inside `within`, or there are no more.
		const page = MAX_FOUND * 2;
		const kept: Array<{node: FileNodeRow; trail: FileNodeRow[]}> = [];
		for (let skip = 0; kept.length < MAX_FOUND; skip += page) {
			const matches = await db.fileNode.findMany({
				where: {connectionId, trashedAt: null, name: {contains: search, mode: 'insensitive'}},
				select: nodeSelect,
				orderBy: [{name: 'asc'}, {id: 'asc'}],
				skip,
				take: page,
			});
			const byId = await foldersAbove(db, connectionId, matches);
			for (const node of matches) {
				const trail = trailIn(byId, node.parentId);
				if (trail === null || trail.some((folder) => folder.trashedAt !== null)) {
					continue;
				}
				if (within !== null && !trail.some((folder) => folder.id === within)) {
					continue;
				}
				kept.push({node, trail});
			}
			if (matches.length < page) {
				break;
			}
		}
		const shown = kept.slice(0, MAX_FOUND);
		const entries = await withHeads(
			db,
			shown.map(({node}) => node),
		);
		return entries.map((entry, index) => ({
			...entry,
			trail: shown[index]?.trail ?? [],
			trashed: false,
		}));
	});
}

/** A file at the top of a drive with what it holds now and the blob with its bytes. */
export type TopFile = FileNodeRow & {head: StoredVersionRow & {blob: FileBlobRow}};

/**
 * The files at the top of a drive, outside the trash, each with what it holds now and the blob
 * with its bytes, the latest changed first, at most `take`: for a drive read whole, as a member's
 * memory is (api native/memory). Folders, and files with nothing in them, are left out.
 */
export function listTopFiles(
	connectionId: string,
	take: number,
): Promise<Result<TopFile[], ApiError>> {
	return wrapDb(async () => {
		const nodes = await db.fileNode.findMany({
			where: {
				connectionId,
				parentId: null,
				folder: false,
				trashedAt: null,
				headVersionId: {not: null},
			},
			select: nodeSelect,
			orderBy: [{updatedAt: 'desc'}, {id: 'asc'}],
			take,
		});
		const ids = nodes.flatMap((node) => (node.headVersionId === null ? [] : [node.headVersionId]));
		const versions = await db.fileVersion.findMany({
			where: {id: {in: ids}},
			select: {...versionSelect, blob: {select: blobSelect}},
		});
		const byId = new Map(versions.map((version) => [version.id, version]));
		return nodes.flatMap((node) => {
			const head = node.headVersionId === null ? undefined : byId.get(node.headVersionId);
			if (!head || head.blob === null || !isStored(head)) {
				return [];
			}
			return [{...node, head: {...head, blob: head.blob}}];
		});
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
		const [entries, byId] = await Promise.all([
			withHeads(db, nodes),
			foldersAbove(db, connectionId, nodes),
		]);
		return entries.map((entry) => {
			const trail = trailIn(byId, entry.parentId);
			if (trail === null) {
				throw ApiErr.notFound('folder', entry.parentId ?? undefined);
			}
			return {...entry, trail, trashed: true};
		});
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

// A file of Files' next version, its bytes in the store.
async function insertStored(
	tx: Tx,
	connectionId: string,
	fileId: string,
	content: NewContent,
): Promise<StoredVersionRow> {
	const version = await insertVersion(tx, connectionId, fileId, {
		...content,
		sourceRevision: null,
		sourceType: null,
	});
	return stored(version);
}

/**
 * Whether a new file called `name` could go in `parentId` now, as `createFile` checks it: a folder
 * of the drive's, outside the trash, with nothing there called that. For what is checked before
 * anything is made on the way to it, as the folders a push to a path makes.
 */
export function checkNewFile(
	connectionId: string,
	data: {parentId: string | null; name: string},
): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await requireOpenFolder(db, connectionId, data.parentId);
		if (await isTaken(db, connectionId, data.parentId, data.name)) {
			throw nameTaken(data.name);
		}
	});
}

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
			const head = await insertStored(tx, connectionId, made.id, data.content);
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
			const head = await insertStored(tx, connectionId, node.id, data.content);
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
			const found = await tx.fileVersion.findFirst({
				where: {id: data.versionId, connectionId, fileId: node.id},
				select: versionSelect,
			});
			if (!found) {
				throw ApiErr.notFound('version', data.versionId);
			}
			const earlier = stored(found);
			if (node.headVersionId === earlier.id) {
				return {...node, head: earlier};
			}
			const head = await insertStored(tx, connectionId, node.id, {
				blobId: earlier.blobId,
				size: earlier.size,
				type: earlier.type,
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
			// What the folder holds goes with it: the deepest of it may be no deeper than anything
			// may be put.
			if (
				node.folder &&
				parentId !== node.parentId &&
				trail.length + (await levelsBelow(tx, connectionId, node.id)) >= MAX_DEPTH
			) {
				throw ApiErr.validationError('Folders can’t be nested that deep.');
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

/**
 * A drive elsewhere's file's next version, recorded by its connection's id and its id there: a
 * copy taken before a change, or a revision the drive keeps. Where the newest version holds that
 * revision already, kept as well, it is answered and nothing is recorded, so two changes that
 * copy a file at once keep one copy; the other's blob is left for the sweep.
 */
export function recordFileVersion(data: {
	connectionId: string;
	fileId: string;
	content: RecordedContent;
}): Promise<Result<FileVersionRow, ApiError>> {
	const {connectionId, fileId, content} = data;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockFile(tx, connectionId, fileId);
			const latest = await latestVersion(tx, connectionId, fileId);
			if (latest && holdsAlready(latest, content)) {
				const {blob: _blob, ...version} = latest;
				return version;
			}
			return insertVersion(tx, connectionId, fileId, content);
		}),
	);
}

/**
 * A change made to a drive elsewhere's file, logged as whoever made it, with the version it made
 * where it made one (`made`), recorded with it as its after version; neither without the other.
 */
export function logFileChange(
	change: FileChangeBy,
	entry: Journaled & {made?: RecordedContent},
): Promise<Result<{change: FileChangeRow; version: FileVersionRow | null}, ApiError>> {
	const {made, ...journaled} = entry;
	const {connectionId} = change;
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			await lockFile(tx, connectionId, entry.fileId);
			if (!made) {
				return {change: await journal(tx, change, journaled), version: null};
			}
			const version = await insertVersion(tx, connectionId, entry.fileId, made);
			const logged = await journal(tx, change, {...journaled, afterVersion: version.id});
			return {change: logged, version};
		}),
	);
}

/**
 * Whether a task has had its copy of a file: it changed the file before, starting from a version
 * recorded here, or made it. A copy is taken before a task's first change to a file only.
 */
export function hasTaskCopied(
	connectionId: string,
	fileId: string,
	taskId: string,
): Promise<Result<boolean, ApiError>> {
	return wrapDb(async () => {
		const found = await db.fileChange.findFirst({
			where: {
				connectionId,
				fileId,
				taskId,
				OR: [{beforeVersion: {not: null}}, {kind: 'create'}],
			},
			select: {id: true},
		});
		return found !== null;
	});
}

/** The newest of a file's versions, with its blob where it has one; `Ok(null)` for none. */
export function getLatestFileVersion(
	connectionId: string,
	fileId: string,
): Promise<Result<FileVersionFound | null, ApiError>> {
	return wrapDb(() => latestVersion(db, connectionId, fileId));
}

/** One change of a drive's journal, its inverse read as one this server knows; `Ok(null)` for none. */
export function getFileChange(
	connectionId: string,
	id: string,
): Promise<Result<FileChangeRow | null, ApiError>> {
	return wrapDb(async () => {
		const row = await db.fileChange.findFirst({where: {id, connectionId}, select: changeSelect});
		return row ? changeRow(row) : null;
	});
}

/**
 * An agent that made what a file holds, by a version it wrote or gave back: as the persona it
 * worked as, where it was one of the Chat page's and the persona is still there, or else as itself.
 */
export type FileMaker =
	| {kind: 'persona'; id: string; name: string; look: string; color: string}
	| {kind: 'agent'; id: string; name: string; providerId: string};

type AgentChange = {agentId: string | null; taskId: string | null};

// The agents, tasks and personas behind changes, read at once: each change's maker, where an agent
// made it and the agent is still there, and its task.
async function makersOf(changes: AgentChange[]): Promise<{
	makerOf: (change: AgentChange) => FileMaker | null;
	taskOf: (change: AgentChange) => {id: string; title: string} | null;
}> {
	const ids = <K extends keyof AgentChange>(key: K) => [
		...new Set(changes.flatMap((change) => (change[key] === null ? [] : [change[key]]))),
	];
	const [agents, tasks] = await Promise.all([
		db.agent.findMany({
			where: {id: {in: ids('agentId')}},
			select: {id: true, name: true, providerId: true},
		}),
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
					select: {id: true, name: true, look: true, color: true},
				});
	const taskOf = (change: AgentChange) => tasks.find((task) => task.id === change.taskId) ?? null;
	return {
		makerOf: (change) => {
			const personaId = taskOf(change)?.personaId;
			const persona = personas.find((candidate) => candidate.id === personaId);
			if (persona) {
				return {kind: 'persona', ...persona};
			}
			const agent = agents.find((candidate) => candidate.id === change.agentId);
			return agent ? {kind: 'agent', ...agent} : null;
		},
		taskOf: (change) => {
			const task = taskOf(change);
			return task ? {id: task.id, title: task.title} : null;
		},
	};
}

/**
 * Who made a version, as far as the journal has it, and what the file was called then: the
 * member, or the agent as its maker and the task it was for.
 */
export type VersionAuthor = {
	kind: FileChangeKind;
	name: string;
	user: {name: string | null; email: string; image: string | null} | null;
	maker: FileMaker | null;
	task: {id: string; title: string} | null;
};

export type FileVersionEntry = FileVersionRow & {author: VersionAuthor | null};

// The changes that make what a file holds, all of it or a part, and so who made a version.
const MAKING: FileChangeKind[] = ['create', 'write', 'restore', 'edit'];

/**
 * A file's versions, newest first, each with who made it: a drive elsewhere's with or without a
 * copy here, and with no maker where it is a copy taken of what the file held.
 */
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
				kind: {in: MAKING},
			},
			select: {
				kind: true,
				name: true,
				afterVersion: true,
				userId: true,
				agentId: true,
				taskId: true,
			},
		});
		const userIds = [
			...new Set(changes.flatMap((change) => (change.userId === null ? [] : [change.userId]))),
		];
		const [users, {makerOf, taskOf}] = await Promise.all([
			db.user.findMany({
				where: {id: {in: userIds}},
				select: {id: true, name: true, email: true, image: true},
			}),
			makersOf(changes),
		]);
		return versions.map((version) => {
			const change = changes.find((candidate) => candidate.afterVersion === version.id);
			if (!change) {
				return {...version, author: null};
			}
			const user = users.find((candidate) => candidate.id === change.userId);
			return {
				...version,
				author: {
					kind: change.kind,
					name: change.name,
					user: user ? {name: user.name, email: user.email, image: user.image} : null,
					maker: makerOf(change),
					task: taskOf(change),
				},
			};
		});
	});
}

/** One change of a file's journal with who made it: the member, or the agent as its maker and the task it was for. */
export type FileChangeEntry = FileChangeRow & {
	user: {name: string | null; email: string; image: string | null} | null;
	maker: FileMaker | null;
	task: {id: string; title: string} | null;
};

// Changes as the journal lists them, each with who made it.
async function withAuthors(
	rows: Prisma.FileChangeGetPayload<{select: typeof changeSelect}>[],
): Promise<FileChangeEntry[]> {
	const userIds = [
		...new Set(rows.flatMap((change) => (change.userId === null ? [] : [change.userId]))),
	];
	const [users, {makerOf, taskOf}] = await Promise.all([
		db.user.findMany({
			where: {id: {in: userIds}},
			select: {id: true, name: true, email: true, image: true},
		}),
		makersOf(rows),
	]);
	return rows.map((row) => {
		const user = users.find((candidate) => candidate.id === row.userId);
		return {
			...changeRow(row),
			user: user ? {name: user.name, email: user.email, image: user.image} : null,
			maker: makerOf(row),
			task: taskOf(row),
		};
	});
}

/**
 * A file's changes, newest first, at most `limit`, each with who made it: for a drive elsewhere,
 * whose versions are copies taken before changes, what each change was and what it started from.
 */
export function listFileChanges(
	connectionId: string,
	fileId: string,
	limit: number,
): Promise<Result<FileChangeEntry[], ApiError>> {
	return wrapDb(async () => {
		const rows = await db.fileChange.findMany({
			where: {connectionId, fileId},
			select: changeSelect,
			orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
			take: limit,
		});
		return withAuthors(rows);
	});
}

/**
 * The latest change of each of a drive's files that has any, the most recently changed file first,
 * at most `limit` files: the files a drive elsewhere has a history of here, each as it was called
 * then.
 */
export function listChangedFiles(
	connectionId: string,
	limit: number,
): Promise<Result<FileChangeEntry[], ApiError>> {
	return wrapDb(async () => {
		const latest = await db.fileChange.groupBy({
			by: ['fileId'],
			where: {connectionId},
			_max: {createdAt: true},
			orderBy: {_max: {createdAt: 'desc'}},
			take: limit,
		});
		if (latest.length === 0) {
			return [];
		}
		const rows = await db.fileChange.findMany({
			where: {
				connectionId,
				OR: latest.flatMap(({fileId, _max}) =>
					_max.createdAt === null ? [] : [{fileId, createdAt: _max.createdAt}],
				),
			},
			select: changeSelect,
			orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
		});
		// Two changes of a file at the same moment: the one listed first, as listFileChanges lists them.
		const first = rows.filter(
			(row, index) => rows.findIndex((other) => other.fileId === row.fileId) === index,
		);
		return withAuthors(first);
	});
}

/**
 * The agents that made what each of `fileIds` holds, by file, the latest first, each once; a file
 * only members made has none. One whose agent is gone is left out.
 */
export function listFileMakers(
	connectionId: string,
	fileIds: string[],
): Promise<Result<Map<string, FileMaker[]>, ApiError>> {
	return wrapDb(async () => {
		const makers = new Map<string, FileMaker[]>();
		if (fileIds.length === 0) {
			return makers;
		}
		const changes = await db.fileChange.findMany({
			where: {
				connectionId,
				fileId: {in: fileIds},
				agentId: {not: null},
				kind: {in: MAKING},
			},
			select: {fileId: true, agentId: true, taskId: true},
			orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
		});
		const {makerOf} = await makersOf(changes);
		for (const change of changes) {
			const maker = makerOf(change);
			const made = makers.get(change.fileId) ?? [];
			if (
				maker === null ||
				made.some((other) => other.kind === maker.kind && other.id === maker.id)
			) {
				continue;
			}
			makers.set(change.fileId, [...made, maker]);
		}
		return makers;
	});
}

/**
 * One of a file's versions with the blob that has its bytes; `Ok(null)` for none, and for one
 * kept only in the drive the file is in, which `findFileVersion` reads.
 */
export function getFileVersion(
	connectionId: string,
	fileId: string,
	versionId: string,
): Promise<Result<(StoredVersionRow & {blob: FileBlobRow}) | null, ApiError>> {
	return wrapDb(async () => {
		const version = await db.fileVersion.findFirst({
			where: {id: versionId, connectionId, fileId},
			select: {...versionSelect, blob: {select: blobSelect}},
		});
		if (!version) {
			return null;
		}
		const {blob} = version;
		if (blob === null || !isStored(version)) {
			return null;
		}
		return {...version, blob};
	});
}

/** One of a file's versions as recorded, with its blob or none; `Ok(null)` for none. */
export function findFileVersion(
	connectionId: string,
	fileId: string,
	versionId: string,
): Promise<Result<FileVersionFound | null, ApiError>> {
	return wrapDb(() =>
		db.fileVersion.findFirst({
			where: {id: versionId, connectionId, fileId},
			select: {...versionSelect, blob: {select: blobSelect}},
		}),
	);
}

/** A blob's row, by its id; none where it is gone. */
export function getFileBlob(id: string): Promise<Result<FileBlobRow | null, ApiError>> {
	return wrapDb(() => db.fileBlob.findUnique({where: {id}, select: blobSelect}));
}

/** A blob's row, made before its bytes are sent to the store under `key`: an agent's, with the file's name and type, where it is one. */
export function createFileBlob(data: {
	orgId: string;
	backendId: string;
	key: string;
	agentId?: string;
	name?: string | null;
	type?: string | null;
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

/** The blobs made before `before` that no version points at: an agent's never used or sent on to a drive elsewhere, and what their drive or the trash's purge left. */
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
