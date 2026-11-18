import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';

import {fileIdOf} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {getPresentation, replaceAllText} from '../connections/google/slides-api';
import type {NativeToolRun, NativeToolRunner} from '../native/tool';
import {changeBy, changeDriveFile, loggedAs, type DriveEditor} from './google-history';

/**
 * A Google Slides file's text, read and replaced in place through the Slides API, keeping its
 * slides, layout and formatting: `slides_read` answers each slide's text, its shapes' and tables'
 * and those in groups, with the revision it was read at; `slides_edit` replaces text everywhere
 * it appears in the presentation, matched with its case, as Slides' own find and replace does,
 * only to the revision the agent read: on a read of an older one, it is turned down, and the agent
 * reads the presentation again. A replacement goes through the presentation's history
 * (google-history.ts): a copy of it kept before a task's first change, and logged as an edit.
 */

// The most texts replaced at once.
const MAX_REPLACEMENTS = 100;

// A tool's params read against its schema; what is wrong is said with the tool's own params named.
function read<T>(schema: z.ZodType<T>, tool: string, takes: string, params: Record<string, unknown>): Result<T, ApiError> {
	const parsed = schema.safeParse(params);
	if (!parsed.success) {
		return Err(ApiErr.validationError(`${tool} takes ${takes}:\n${z.prettifyError(parsed.error)}`));
	}
	return Ok(parsed.data);
}

function requirePresentationId(given: string): Result<string, ApiError> {
	return requirePresent(fileIdOf(given), ApiErr.validationError('Say which presentation as id: its id, as files_list gives it, or its link'));
}

function editorOf(run: NativeToolRun, token: string): DriveEditor {
	return {token, change: changeBy(run.connection, {agentId: run.caller.agent.agentId, taskId: run.caller.taskId})};
}

function linkOf(presentationId: string): string {
	return `https://docs.google.com/presentation/d/${presentationId}/edit`;
}

const idSchema = z.object({id: z.string().min(1)});

/** `slides_read`: a Slides file's text, slide by slide, and the revision it was read at. */
export const runSlidesRead: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id} = $(read(idSchema, 'slides_read', 'id', run.params));
		const presentationId = $(requirePresentationId(id));
		const presentation = $(await callGoogle(run.connection, (token) => getPresentation(token, presentationId)));
		const slides = presentation.slides.flatMap((texts, index) => ['', `Slide ${index + 1}:`, ...(texts.length === 0 ? ['(no text)'] : texts.map((text) => text.replace(/\n$/, '')))]);
		return [`“${presentation.title}”, at revision ${presentation.revisionId}, which slides_edit takes as revision.`, `Link: ${linkOf(presentationId)}`, ...slides].join('\n');
	});

const slidesEditSchema = z.object({
	id: z.string().min(1),
	revision: z.string().min(1),
	replace: z
		.array(z.strictObject({find: z.string().min(1), replace: z.string()}))
		.min(1)
		.max(MAX_REPLACEMENTS),
});

type Replacement = {find: string; replace: string};

function staleText(revision: string): string {
	return `The presentation changed since revision ${revision} was read, or that revision is too old: nothing was replaced. Read it again with slides_read, and replace text on what it holds now, with its new revision.`;
}

// The text replaced, only at the revision read, through the presentation's history.
function replaceIn(editor: DriveEditor, presentationId: string, revision: string, replacements: Replacement[]): Promise<Result<{replaced: number[]; revisionId: string | null}, ApiError>> {
	return changeDriveFile(editor, presentationId, {content: true}, () => loggedAs({kind: 'edit'}, replaceAllText(editor.token, presentationId, replacements, revision, staleText(revision))));
}

function timesText(count: number): string {
	if (count === 0) {
		return 'appears nowhere, so nothing was replaced';
	}
	return count === 1 ? 'replaced once' : `replaced ${count} times`;
}

/** `slides_edit`: text replaced everywhere in a Slides file, only at the revision the agent read. */
export const runSlidesEdit: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const params = $(read(slidesEditSchema, 'slides_edit', 'id, revision and replace, each a find and its replace', run.params));
		const presentationId = $(requirePresentationId(params.id));
		const done = $(await callGoogle(run.connection, (token) => replaceIn(editorOf(run, token), presentationId, params.revision, params.replace)));
		const lines = params.replace.map(({find}, index) => `“${find}”: ${timesText(done.replaced[index] ?? 0)}`);
		const next =
			done.revisionId === null ? 'Read it again with slides_read for its new revision before replacing more.' : `It is at revision ${done.revisionId} now, which slides_edit takes for more.`;
		return [...lines, next, `Link: ${linkOf(presentationId)}`].join('\n');
	});
