import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {createFile, type FileChangeBy, findPath, trashFile, writeFile} from '@proxy/db/files';

import type {NativeToolRun, NativeToolRunner} from '../tool';
import {requireFile} from '../files/connector';
import {maxFileBytes, storeText} from '../files/content';
import {nameOf, requireContent, titleOf} from './notes';

/**
 * The memory's tools: writing a note, new or over the version read, and forgetting one, each as
 * the agent, for the task the call is run for, which the drive's journal keeps (db/files.ts), so
 * the person sees which of their agents wrote what, and every version before stays.
 */

const NOTE_TYPE = 'text/markdown';

function changeOf({caller, connection}: NativeToolRun): FileChangeBy {
	return {orgId: connection.orgId, connectionId: connection.id, by: {agentId: caller.agent.agentId, taskId: caller.taskId}};
}

function read<T>(schema: z.ZodType<T>, tool: string, takes: string, params: Record<string, unknown>): Result<T, ApiError> {
	return parseSchema(schema, params).mapErr((error) => ApiErr.validationError(`${tool} takes ${takes}${error.kind === 'parse_error' ? `: ${error.message}` : ''}`));
}

const writeSchema = z.object({title: z.string(), content: z.string(), version: z.string().min(1).optional()});

/** memory_write: a note written, new under a title none has, or over the version the agent read. */
export const runMemoryWrite: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {title: raw, content, version} = $(read(writeSchema, 'memory_write', 'title and content, and version to change a note', run.params));
		const name = $(nameOf(raw));
		const title = titleOf(name);
		$(requireContent(title, content));
		const {found, missing} = $(await findPath(run.connection.id, [name]));
		const note = missing.length === 0 ? found[0] : undefined;
		if (note !== undefined && version === undefined) {
			return $(Err(ApiErr.conflict(`There is a note called “${title}” already, ${note.id}: read it with notes_get, then write it with the version it answers with.`)));
		}
		if (note !== undefined && note.head?.id !== version) {
			return $(Err(ApiErr.conflict(`“${title}” changed since that version was read: it holds ${note.head?.id ?? 'nothing'} now. Read it again with notes_get, then write.`)));
		}
		if (note === undefined && version !== undefined) {
			return $(Err(ApiErr.notFound('note', title, 'No note has that title: leave version out to make one.')));
		}
		const stored = $(await storeText(run.connection.orgId, content, maxFileBytes()));
		const kept = {blobId: stored.blobId, size: stored.size, type: NOTE_TYPE};
		const written =
			note === undefined || version === undefined
				? $(await createFile(changeOf(run), {parentId: null, name, content: kept}))
				: $(await writeFile(changeOf(run), {fileId: note.id, ifVersion: version, content: kept}));
		const said = note === undefined ? `Wrote the new note “${title}”.` : `Wrote “${title}”. The version before is kept.`;
		return [said, `Id: ${written.id}`, `Version: ${written.head?.id ?? ''}`].join('\n');
	});

const forgetSchema = z.object({id: z.string().min(1)});

/** memory_forget: a note put in the trash, which the person can take it out of. */
export const runMemoryForget: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id} = $(read(forgetSchema, 'memory_forget', 'id', run.params));
		const file = $(await requireFile(run.connection.id, id));
		if (file.folder || file.parentId !== null) {
			return $(Err(ApiErr.notFound('note', id, 'notes_list lists them.')));
		}
		const trashed = $(await trashFile(changeOf(run), id));
		return `Forgot “${titleOf(trashed.name)}”. It is in the trash, where the person can take it back.`;
	});
