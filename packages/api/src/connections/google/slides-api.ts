import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {googleRequest, googleRevisionWrite} from './google-client';

/**
 * The Slides v1 calls `slides_read` and `slides_edit` make, and the reading of their answers: a
 * presentation's slides and the text in their shapes and tables, groups too, with the revision it
 * was read at; and text replaced throughout it, only at that revision.
 */

const SLIDES = 'https://slides.googleapis.com/v1/presentations';

const textSchema = z.object({textElements: z.array(z.object({textRun: z.object({content: z.string().optional()}).optional()})).optional()});

type SlideText = z.infer<typeof textSchema>;

/** Something on a slide: a shape with its text, a table with text in its cells, or a group of more. */
export type PageElement = {
	shape?: {text?: SlideText};
	table?: {tableRows?: {tableCells?: {text?: SlideText}[]}[]};
	elementGroup?: {children?: PageElement[]};
};

const pageElementSchema: z.ZodType<PageElement> = z.lazy(() =>
	z.object({
		shape: z.object({text: textSchema.optional()}).optional(),
		table: z.object({tableRows: z.array(z.object({tableCells: z.array(z.object({text: textSchema.optional()})).optional()})).optional()}).optional(),
		elementGroup: z.object({children: z.array(pageElementSchema).optional()}).optional(),
	}),
);

const presentationSchema = z.object({
	title: z.string().optional(),
	revisionId: z.string(),
	slides: z.array(z.object({objectId: z.string(), pageElements: z.array(pageElementSchema).optional()})).optional(),
});

/** One slide: its id, and its text, a shape's or a cell's a part of it. */
export type Slide = {id: string; texts: string[]};

/** A presentation as `presentations.get` answers it: its title, the revision read, and its slides. */
export type GooglePresentation = {title: string; revisionId: string; slides: Slide[]};

function textOf(text: SlideText | undefined): string {
	return (text?.textElements ?? []).map((element) => element.textRun?.content ?? '').join('');
}

// The text of each shape and table cell on a slide, in the order Slides lists them; none empty.
function textsOf(elements: PageElement[]): string[] {
	return elements.flatMap((element) => {
		const cells = (element.table?.tableRows ?? []).flatMap((row) => (row.tableCells ?? []).map((cell) => textOf(cell.text)));
		return [textOf(element.shape?.text), ...cells, ...textsOf(element.elementGroup?.children ?? [])].filter((text) => text.trim() !== '');
	});
}

/** A presentation's slides, each as the text on it, as of its revision. */
export async function getPresentation(accessToken: string, presentationId: string): Promise<Result<GooglePresentation, ApiError>> {
	const url = new URL(`${SLIDES}/${presentationId}`);
	url.searchParams.set('fields', 'title,revisionId,slides(objectId,pageElements)');
	const answer = await googleRequest(accessToken, url, presentationSchema);
	return answer.map((presentation) => ({
		title: presentation.title ?? '',
		revisionId: presentation.revisionId,
		slides: (presentation.slides ?? []).map((slide) => ({id: slide.objectId, texts: textsOf(slide.pageElements ?? [])})),
	}));
}

const batchUpdateSchema = z.object({
	replies: z.array(z.object({replaceAllText: z.object({occurrencesChanged: z.number().optional()}).optional()})).optional(),
	writeControl: z.object({requiredRevisionId: z.string().optional()}).optional(),
});

/** Text to replace, matched with its case, on the slides given by their ids. */
export type SlideReplacement = {find: string; replace: string; slideIds: string[]};

/**
 * Replaces each text, matched with its case, on the slides it names, one after another, only at
 * `revisionId`: one changed since is turned down as a `conflict` saying `stale`. Answers how many
 * times each was replaced, and the revision the presentation is at after them, where Google says
 * it.
 */
export async function replaceAllText(
	accessToken: string,
	presentationId: string,
	replacements: SlideReplacement[],
	revisionId: string,
	stale: string,
): Promise<Result<{replaced: number[]; revisionId: string | null}, ApiError>> {
	const requests = replacements.map(({find, replace, slideIds}) => ({replaceAllText: {containsText: {text: find, matchCase: true}, replaceText: replace, pageObjectIds: slideIds}}));
	const url = new URL(`${SLIDES}/${presentationId}:batchUpdate`);
	const answer = await googleRevisionWrite(accessToken, url, {requests, writeControl: {requiredRevisionId: revisionId}}, batchUpdateSchema, stale);
	return answer.map((updated) => ({
		replaced: replacements.map((_, index) => updated.replies?.[index]?.replaceAllText?.occurrencesChanged ?? 0),
		revisionId: updated.writeControl?.requiredRevisionId ?? null,
	}));
}
