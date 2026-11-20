import {z} from 'zod';
import {fileAuthorSchema} from './files';

/**
 * Personal Agent Proxy's history of a Google connection's files in Drive, as the person reads it on
 * the connection's page (`/api/orgs/:org/connections/:connectionId/drive-history/…`): the files
 * changed through it, and a file's versions, each a copy kept before a task first changed it, and
 * its changes, who made each and for which task. A version is given back and a change with an exact
 * undo undone from there, as the member's own changes.
 */

/** What a change did to a file. */
const DRIVE_CHANGE_KINDS = [
	'create',
	'write',
	'move',
	'trash',
	'untrash',
	'restore',
	'edit',
] as const;

/** `GET drive-history`: the files changed through Personal Agent Proxy, the latest changed first, each by its latest change. */
export const driveHistoryListSchema = z.object({
	files: z.array(
		z.object({
			id: z.string(),
			/** What the change called it. */
			name: z.string(),
			at: z.string(),
			kind: z.enum(DRIVE_CHANGE_KINDS),
			by: fileAuthorSchema.nullable(),
		}),
	),
});

export type DriveHistoryList = z.infer<typeof driveHistoryListSchema>;

/**
 * One version kept of a file: kept here, its bytes in Personal Agent Proxy, or only as Drive's own
 * revision, which Drive keeps for good meanwhile where Personal Agent Proxy pinned it; whether it
 * can be given back from here, which a Doc's, Sheet's or Slides file's never can be, its link's
 * File > Version history can; and who made the change it was kept before, or who made it, as a
 * restore makes one.
 */
export const driveVersionSchema = z.object({
	id: z.string(),
	at: z.string(),
	kept: z.enum(['here', 'drive']),
	/** The copy's size in bytes, or Drive's of the revision; null where neither is known. */
	size: z.number().nullable(),
	type: z.string(),
	pinned: z.boolean(),
	restorable: z.boolean(),
	/** `before`: the copy of what the file held before a change; `made`: what a change made. */
	origin: z.enum(['before', 'made']).nullable(),
	by: fileAuthorSchema.nullable(),
});

export type DriveVersion = z.infer<typeof driveVersionSchema>;

/** One change made to a file through Personal Agent Proxy: what it was, by whom, and the cells an exact undo puts back, where it has one. */
export const driveChangeSchema = z.object({
	id: z.string(),
	at: z.string(),
	kind: z.enum(DRIVE_CHANGE_KINDS),
	/** What the change called the file, and what a rename called it before. */
	name: z.string(),
	beforeName: z.string().nullable(),
	by: fileAuthorSchema.nullable(),
	cells: z.object({tab: z.string(), range: z.string()}).nullable(),
});

export type DriveChange = z.infer<typeof driveChangeSchema>;

/**
 * `GET drive-history/:fileId`: the file as Drive has it now, its link, and whether it is a Doc,
 * Sheet or Slides file (`google`); its versions, newest first, and its latest changes, newest first.
 */
export const driveFileHistorySchema = z.object({
	file: z.object({
		id: z.string(),
		name: z.string(),
		link: z.string().nullable(),
		google: z.boolean(),
	}),
	versions: z.array(driveVersionSchema),
	changes: z.array(driveChangeSchema),
});

export type DriveFileHistory = z.infer<typeof driveFileHistorySchema>;

/**
 * `POST drive-history/:fileId/restore`: a version given back as the file's newest revision in
 * Drive. `POST drive-history/:fileId/changes/:changeId/undo`: a change's exact inverse applied.
 * Both answer nothing; the file's history is read again.
 */
export const restoreDriveVersionBodySchema = z.object({version: z.string().min(1)});
