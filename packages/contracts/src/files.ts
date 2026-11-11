import {z} from 'zod';
import {AVATAR_COLORS, lookSchema} from '@proxy/utils/harness';

/**
 * Files, a drive kept in Personal Agent Proxy itself, as the person reads and changes it on its
 * connection's page (`/api/orgs/:org/connections/:connectionId/files/…`): its folders and files,
 * a file's versions, and the changes a person makes. A file's bytes go up and come down as they
 * are, not as JSON: an upload's body is the file, sent as `application/octet-stream` whatever it
 * holds, with its name and its type in the address.
 */

/** A file or a folder, as a list shows it: a file with what it holds now. */
export const fileSchema = z.object({
	id: z.string(),
	name: z.string(),
	folder: z.boolean(),
	/** The folder it is in; null at the top of the drive. */
	parentId: z.string().nullable(),
	/**
	 * Where a search found it or the trash has it from: the folders above it, from the top down,
	 * as `Reports / 2026`, empty at the top of the drive. Null in a folder's own list, where the
	 * list says it.
	 */
	path: z.string().nullable(),
	/** What a file holds now: its version's id, the media type and the size in bytes; null for a folder. */
	version: z.string().nullable(),
	type: z.string().nullable(),
	size: z.number().nullable(),
	/** Whether a browser may show it in place, as a picture: what the content route sends inline. */
	shown: z.boolean(),
	modifiedAt: z.string(),
	/** When it was put in the trash; null outside it. */
	trashedAt: z.string().nullable(),
});

export type DriveFile = z.infer<typeof fileSchema>;

/**
 * An agent that made what a file holds, by a version it wrote or gave back: as the persona of the
 * Chat page it worked as, with its head, or as itself, with what it is.
 */
const personaMakerSchema = z.object({
	kind: z.literal('persona'),
	id: z.string(),
	name: z.string(),
	look: lookSchema,
	color: z.enum(AVATAR_COLORS),
});
const agentMakerSchema = z.object({
	kind: z.literal('agent'),
	id: z.string(),
	name: z.string(),
	providerId: z.string(),
});

export const fileMakerSchema = z.discriminatedUnion('kind', [personaMakerSchema, agentMakerSchema]);

export type FileMaker = z.infer<typeof fileMakerSchema>;

/** A file or a folder in a list: with the agents that made what it holds, the latest first. */
export const listedFileSchema = fileSchema.extend({makers: z.array(fileMakerSchema)});

export type ListedFile = z.infer<typeof listedFileSchema>;

/** A folder above a file or a list, by its id and name. */
export const fileCrumbSchema = z.object({id: z.string(), name: z.string()});

export type FileCrumb = z.infer<typeof fileCrumbSchema>;

/**
 * `GET files?parent=&search=`: what a folder holds, the top's without `parent`, folders first,
 * or what a search by name finds, anywhere or inside it; and the folders from the top down to the
 * one listed. `GET files/trash`: what is in the trash, last trashed first.
 */
export const fileListSchema = z.object({
	files: z.array(listedFileSchema),
	trail: z.array(fileCrumbSchema),
});

export const listFilesQuerySchema = z.object({
	parent: z.string().min(1).optional(),
	search: z.string().trim().max(200).optional(),
});

export type FileList = z.infer<typeof fileListSchema>;

/** The task an agent made a version for; null where the journal has none. */
const versionTaskSchema = z.object({id: z.string(), title: z.string()}).nullable();

/**
 * One of a file's versions: what the file was called and held then, when it was made, and by whom
 * as far as it is known: a member, or an agent as the file's makers are drawn, with the task it
 * was for; and whether it gave an earlier version back.
 */
export const fileVersionSchema = z.object({
	id: z.string(),
	/** The file's name when the version was made; its name now where the journal has none. */
	name: z.string(),
	size: z.number(),
	type: z.string(),
	at: z.string(),
	/** The one the file holds now. */
	current: z.boolean(),
	by: z
		.discriminatedUnion('kind', [
			z.object({
				kind: z.literal('person'),
				name: z.string(),
				email: z.string(),
				image: z.string().nullable(),
			}),
			personaMakerSchema.extend({task: versionTaskSchema}),
			agentMakerSchema.extend({task: versionTaskSchema}),
		])
		.nullable(),
	restored: z.boolean(),
});

export type FileVersion = z.infer<typeof fileVersionSchema>;

/** `GET files/:fileId`: a file or a folder, the folders above it, and a file's versions, newest first. */
export const fileDetailSchema = z.object({
	file: fileSchema,
	trail: z.array(fileCrumbSchema),
	versions: z.array(fileVersionSchema),
});

export type FileDetail = z.infer<typeof fileDetailSchema>;

/** A file or folder made or changed. */
export const fileAnswerSchema = z.object({file: fileSchema});

const nameSchema = z.string().trim().min(1).max(255);

/** `POST files/folders`: a new folder, in `parent` or at the top. */
export const createFolderBodySchema = z.object({
	name: nameSchema,
	parent: z.string().min(1).nullable().default(null),
});

/**
 * `POST files/uploads?name=&parent=&type=`: a new file, its body the bytes. Where the folder has
 * the name already, the file is called the first free name like it, as `report (2).pdf`.
 * `PUT files/:fileId/content?version=&type=`: a file's next version, its body the bytes, by
 * whoever saw `version`, the one it holds; refused where it holds another by now.
 */
export const uploadQuerySchema = z.object({
	name: nameSchema,
	parent: z.string().min(1).optional(),
	type: z.string().max(200).optional(),
});
export const writeQuerySchema = z.object({
	version: z.string().min(1),
	type: z.string().max(200).optional(),
});

/** `PATCH files/:fileId`: renamed, moved into `parent` (null for the top), or both. */
export const moveFileBodySchema = z.object({
	name: nameSchema.optional(),
	parent: z.string().min(1).nullable().optional(),
});

/** `POST files/:fileId/restore`: an earlier version given back, as the file's next. */
export const restoreFileBodySchema = z.object({version: z.string().min(1)});

/** `GET files/:fileId/content?version=`: the bytes of what the file holds, or of the version named. */
export const contentQuerySchema = z.object({version: z.string().min(1).optional()});
