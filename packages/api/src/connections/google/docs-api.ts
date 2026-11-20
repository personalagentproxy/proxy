import type {Result} from 'ts-results-es';
import {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {googleRequest, googleRevisionWrite} from './google-client';

/**
 * The Docs v1 calls `docs_read` and `docs_edit` make, and the reading of their answers: a
 * document's tabs, each tab's body, its paragraphs and the text runs in them, each at its place in the tab,
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

/** A tab as `documents.get` answers it with its tabs' content: its id and title, its body, and the tabs nested under it. */
type TabElement = {
	tabProperties?: {tabId?: string; title?: string};
	documentTab?: {body?: {content?: StructuralElement[]}};
	childTabs?: TabElement[];
};

const tabSchema: z.ZodType<TabElement> = z.lazy(() =>
	z.object({
		tabProperties: z.object({tabId: z.string().optional(), title: z.string().optional()}).optional(),
		documentTab: z.object({body: z.object({content: z.array(structuralElementSchema).optional()}).optional()}).optional(),
		childTabs: z.array(tabSchema).optional(),
	}),
);

const documentSchema = z.object({
	title: z.string().optional(),
	revisionId: z.string(),
	tabs: z.array(tabSchema).optional(),
});

/** One of a document's tabs: its id, its title, the titles of the tabs it is nested under, and its body's parts. */
export type DocumentTab = {id: string; title: string; parents: string[]; content: StructuralElement[]};

/** A document as `documents.get` answers it: its title, the revision read, and its tabs, in the order Docs shows them, nested ones after the tab they are under. */
export type GoogleDocument = {title: string; revisionId: string; tabs: DocumentTab[]};

// A tab and those nested under it, one after another.
function flatTabs(tabs: TabElement[], parents: string[]): DocumentTab[] {
	return tabs.flatMap((tab) => {
		const title = tab.tabProperties?.title ?? '';
		const own = {id: tab.tabProperties?.tabId ?? '', title, parents, content: tab.documentTab?.body?.content ?? []};
		return [own, ...flatTabs(tab.childTabs ?? [], [...parents, title])];
	});
}

/** A document, every tab of it, as of its revision. */
export async function getDocument(accessToken: string, documentId: string): Promise<Result<GoogleDocument, ApiError>> {
	const url = new URL(`${DOCS}/${documentId}`);
	url.searchParams.set('includeTabsContent', 'true');
	url.searchParams.set('fields', 'title,revisionId,tabs');
	const answer = await googleRequest(accessToken, url, documentSchema);
	return answer.map((document) => ({title: document.title ?? '', revisionId: document.revisionId, tabs: flatTabs(document.tabs ?? [], [])}));
}

/** One of the changes `documents.batchUpdate` takes, as `docs_edit` makes them. */
export type DocumentRequest =
	| {insertText: {location: {index: number; tabId: string}; text: string}}
	| {deleteContentRange: {range: DocumentRange}}
	| {updateTextStyle: {range: DocumentRange; textStyle: TextStyle; fields: string}}
	| {updateParagraphStyle: {range: DocumentRange; paragraphStyle: {namedStyleType: string}; fields: string}};

/** A stretch of one tab's body, from `startIndex` up to `endIndex`. */
export type DocumentRange = {startIndex: number; endIndex: number; tabId: string};

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
