import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {googleRequest, googleRevisionWrite} from './google-client';

/**
 * The Docs v1 calls `docs_read` and `docs_edit` make, and the reading of their answers: a
 * document's body, its paragraphs and the text runs in them, each at its place in the document,
 * counted in UTF-16 code units as the Docs API counts them, with the revision it was read at; and a
 * batch of changes made only to that revision.
 */

const DOCS = 'https://docs.googleapis.com/v1/documents';

const textRunSchema = z.object({content: z.string().optional()});

const paragraphElementSchema = z.object({startIndex: z.number().optional(), endIndex: z.number().optional(), textRun: textRunSchema.optional()});

/** One of a body's parts: a paragraph, a table holding parts of its own in its cells, a table of contents, a section break. */
export type StructuralElement = {
	startIndex?: number;
	endIndex?: number;
	paragraph?: {elements?: z.infer<typeof paragraphElementSchema>[]};
	table?: {tableRows?: {tableCells?: {content?: StructuralElement[]}[]}[]};
	tableOfContents?: {content?: StructuralElement[]};
};

const structuralElementSchema: z.ZodType<StructuralElement> = z.lazy(() =>
	z.object({
		startIndex: z.number().optional(),
		endIndex: z.number().optional(),
		paragraph: z.object({elements: z.array(paragraphElementSchema).optional()}).optional(),
		table: z.object({tableRows: z.array(z.object({tableCells: z.array(z.object({content: z.array(structuralElementSchema).optional()})).optional()})).optional()}).optional(),
		tableOfContents: z.object({content: z.array(structuralElementSchema).optional()}).optional(),
	}),
);

const documentSchema = z.object({
	title: z.string().optional(),
	revisionId: z.string(),
	body: z.object({content: z.array(structuralElementSchema).optional()}).optional(),
});

/** A document as `documents.get` answers it: its title, the revision read, and its body's parts. */
export type GoogleDocument = {title: string; revisionId: string; content: StructuralElement[]};

/** A document's body, as of its revision; the first of its tabs, where it has several. */
export async function getDocument(accessToken: string, documentId: string): Promise<Result<GoogleDocument, ApiError>> {
	const url = new URL(`${DOCS}/${documentId}`);
	url.searchParams.set('fields', 'title,revisionId,body');
	const answer = await googleRequest(accessToken, url, documentSchema);
	return answer.map((document) => ({title: document.title ?? '', revisionId: document.revisionId, content: document.body?.content ?? []}));
}

/** One of the changes `documents.batchUpdate` takes, as `docs_edit` makes them. */
export type DocumentRequest =
	| {insertText: {location: {index: number}; text: string}}
	| {deleteContentRange: {range: {startIndex: number; endIndex: number}}}
	| {updateTextStyle: {range: {startIndex: number; endIndex: number}; textStyle: TextStyle; fields: string}}
	| {updateParagraphStyle: {range: {startIndex: number; endIndex: number}; paragraphStyle: {namedStyleType: string}; fields: string}};

/** The part of a run's style `docs_edit` sets: a link left out of one whose `fields` name it takes the link off. */
export type TextStyle = {bold?: boolean; italic?: boolean; underline?: boolean; link?: {url: string}};

const batchUpdateSchema = z.object({writeControl: z.object({requiredRevisionId: z.string().optional()}).optional()});

/**
 * Makes `requests` in one batch, in order, only to the document at `revisionId`: one changed
 * since is turned down as a `conflict` saying `stale`. Answers the revision the document is at
 * after them, where Google says it.
 */
export async function updateDocument(accessToken: string, documentId: string, requests: DocumentRequest[], revisionId: string, stale: string): Promise<Result<string | null, ApiError>> {
	const url = new URL(`${DOCS}/${documentId}:batchUpdate`);
	const answer = await googleRevisionWrite(accessToken, url, {requests, writeControl: {requiredRevisionId: revisionId}}, batchUpdateSchema, stale);
	return answer.map((updated) => updated.writeControl?.requiredRevisionId ?? null);
}
