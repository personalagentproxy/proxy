import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, requirePresent} from '@proxy/utils';

import {fileIdOf} from '../connections/google/drive-api';
import {callGoogle} from '../connections/google/google-client';
import {getPresentation, replaceAllText, type Slide, type SlideReplacement} from '../connections/google/slides-api';
import {readParams, type NativeToolRunner} from '../native/tool';
import {changeDriveFile, loggedAs, type DriveEditor, runEditor} from './google-history';

/**
 * A Google Slides file's text, read and replaced in place through the Slides API, keeping its
 * slides, layout and formatting: `slides_read` answers each slide's text, its shapes' and tables'
 * and those in groups, with the revision it was read at; `slides_edit` replaces text, matched with
 * its case, as Slides' own find and replace does, as `docs_edit` does in a Doc: each find must
 * appear exactly once, on the slide it names or in the whole presentation, unless it says to
 * replace every time it appears. It is counted here in the text read, and replaced by Slides only
 * on the slides it was found on, only to the revision the agent read: on a read of an older one,
 * it is turned down, and the agent reads the presentation again. A replacement goes through the
 * presentation's history (google-history.ts): a copy of it kept before a task's first change, and
 * logged as an edit.
 */

// The most texts replaced at once.
const MAX_REPLACEMENTS = 100;

function requirePresentationId(given: string): Result<string, ApiError> {
	return requirePresent(fileIdOf(given), ApiErr.validationError('Say which presentation as id: its id, as files_list gives it, or its link'));
}

function linkOf(presentationId: string): string {
	return `https://docs.google.com/presentation/d/${presentationId}/edit`;
}

const idSchema = z.object({id: z.string().min(1)});

/** `slides_read`: a Slides file's text, slide by slide, and the revision it was read at. */
export const runSlidesRead: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const {id} = $(readParams(idSchema, 'slides_read', 'id', run.params));
		const presentationId = $(requirePresentationId(id));
		const presentation = $(await callGoogle(run.connection, (token) => getPresentation(token, presentationId)));
		const slides = presentation.slides.flatMap(({texts}, index) => ['', `Slide ${index + 1}:`, ...(texts.length === 0 ? ['(no text)'] : texts.map((text) => text.replace(/\n$/, '')))]);
		return [`“${presentation.title}”, at revision ${presentation.revisionId}, which slides_edit takes as revision.`, `Link: ${linkOf(presentationId)}`, ...slides].join('\n');
	});

const replacementSchema = z.strictObject({find: z.string().min(1), replace: z.string(), slide: z.number().int().min(1).optional(), all: z.boolean().optional()});

const slidesEditSchema = z.object({
	id: z.string().min(1),
	revision: z.string().min(1),
	replace: z.array(replacementSchema).min(1).max(MAX_REPLACEMENTS),
});

type Replacement = z.infer<typeof replacementSchema>;

const REPLACEMENT_TAKES = 'a find and its replace, and slide and all where wanted';

// A replacement's place in the list, as an agent counts.
function nth(index: number): string {
	return `Replacement ${index + 1}`;
}

// How many times `find` is in `text`, one after another as a replace finds them, none overlapping.
function timesIn(text: string, find: string): number {
	return text.split(find).length - 1;
}

function slidesText(numbers: number[]): string {
	return numbers.length === 1 ? `slide ${numbers[0]}` : `slides ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
}

// The slides a replacement is made on, as it was found on them, or why it can't be: its slide
// isn't there, or its find appears nowhere, or more than once where it isn't to be replaced every time.
function placeOf(slides: Slide[], given: Replacement, index: number): Result<SlideReplacement, string> {
	if (given.slide !== undefined && given.slide > slides.length) {
		return Err(`${nth(index)}: the presentation has ${slides.length} slides, so there is no slide ${given.slide}`);
	}
	const searched = slides.map((slide, at) => ({slide, number: at + 1})).filter(({number}) => given.slide === undefined || number === given.slide);
	const found = searched.flatMap(({slide, number}) => {
		const times = slide.texts.reduce((sum, text) => sum + timesIn(text, given.find), 0);
		return times === 0 ? [] : [{slide, number, times}];
	});
	const times = found.reduce((sum, {times: on}) => sum + on, 0);
	const where = given.slide === undefined ? 'in the presentation' : `on slide ${given.slide}`;
	if (times === 0) {
		return Err(`${nth(index)}: “${given.find}” appears nowhere ${where}. find matches the text as slides_read answers it, exactly, its case too, within one shape or cell.`);
	}
	if (times > 1 && given.all !== true) {
		const spread = found.length > 1 ? `, on ${slidesText(found.map(({number}) => number))}` : '';
		const orSlide = given.slide === undefined && found.length > 1 ? ', name its slide with slide,' : '';
		return Err(`${nth(index)}: “${given.find}” appears ${times} times ${where}${spread}. Make find longer, with the words around it, so it appears once${orSlide} or give all to replace every one.`);
	}
	return Ok({find: given.find, replace: given.replace, slideIds: found.map(({slide}) => slide.id)});
}

// A replacement whose find is in what one before it writes, which the count read before can't tell, or nothing.
function writtenBefore(given: Replacement[], at: number): Result<void, string> {
	const later = given[at];
	const earlier = later === undefined ? -1 : given.slice(0, at).findIndex((one) => one.replace.includes(later.find));
	return earlier === -1 ? Ok(undefined) : Err(`${nth(at)} finds text that ${nth(earlier)} writes: make them one, or replace in two calls`);
}

// Every replacement's slides, refused where any can't be told.
function placeAll(slides: Slide[], given: Replacement[]): Result<SlideReplacement[], ApiError> {
	const results = given.map((one, index) => writtenBefore(given, index).andThen(() => placeOf(slides, one, index)));
	const problems = results.flatMap((result) => (result.isErr() ? [result.error] : []));
	if (problems.length > 0) {
		return Err(ApiErr.validationError(`Nothing was replaced:\n${problems.join('\n')}`));
	}
	return Ok(results.flatMap((result) => (result.isOk() ? [result.value] : [])));
}

function staleText(revision: string): string {
	return `The presentation changed since revision ${revision} was read, or that revision is too old: nothing was replaced. Read it again with slides_read, and replace text on what it holds now, with its new revision.`;
}

// The presentation read, each text counted and placed on its slides, and replaced, only at the
// revision read, through its history. Replacements that can't be placed in a presentation read at
// another revision than the agent's are turned down as stale.
function replaceIn(editor: DriveEditor, presentationId: string, revision: string, given: Replacement[]): Promise<Result<{replaced: number[]; revisionId: string | null}, ApiError>> {
	return Do(async ($) => {
		const presentation = $(await getPresentation(editor.token, presentationId));
		const placed = placeAll(presentation.slides, given);
		if (placed.isErr() && presentation.revisionId !== revision) {
			return $(Err(ApiErr.conflict(staleText(revision))));
		}
		const replacements = $(placed);
		return $(await changeDriveFile(editor, presentationId, {content: true}, () => loggedAs({kind: 'edit'}, replaceAllText(editor.token, presentationId, replacements, revision, staleText(revision)))));
	});
}

function timesText(count: number): string {
	return count === 1 ? 'replaced once' : `replaced ${count} times`;
}

/** `slides_edit`: text replaced in a Slides file, each where it appears once, or every time where asked, only at the revision the agent read. */
export const runSlidesEdit: NativeToolRunner = (run) =>
	Do(async ($): Promise<string> => {
		const params = $(readParams(slidesEditSchema, 'slides_edit', `id, revision and replace, each ${REPLACEMENT_TAKES}`, run.params));
		const presentationId = $(requirePresentationId(params.id));
		const done = $(await callGoogle(run.connection, (token) => replaceIn(runEditor(run, token), presentationId, params.revision, params.replace)));
		const lines = params.replace.map(({find}, index) => `“${find}”: ${timesText(done.replaced[index] ?? 0)}`);
		const next =
			done.revisionId === null ? 'Read it again with slides_read for its new revision before replacing more.' : `It is at revision ${done.revisionId} now, which slides_edit takes for more.`;
		return [...lines, next, `Link: ${linkOf(presentationId)}`].join('\n');
	});
